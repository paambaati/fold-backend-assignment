import { Api, Function, KinesisStream, type StackContext } from 'sst/constructs';
import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Stream } from 'aws-cdk-lib/aws-kinesis';
import { TriggerFunction } from 'aws-cdk-lib/triggers'
import { Domain, EngineVersion } from 'aws-cdk-lib/aws-opensearchservice';
import { Role, ServicePrincipal, Policy, PolicyStatement, Effect, ArnPrincipal, AnyPrincipal, ManagedPolicy, AccountPrincipal } from 'aws-cdk-lib/aws-iam';
import { Credentials, DatabaseInstanceEngine, DatabaseInstance, PostgresEngineVersion, ParameterGroup, DatabaseProxy, ProxyTarget } from 'aws-cdk-lib/aws-rds';
import { InstanceClass, InstanceSize, InstanceType, Vpc, Peer, Port, SecurityGroup, SubnetType, IpAddresses, EbsDeviceVolumeType, CfnSecurityGroupIngress, CfnSecurityGroupEgress, InterfaceVpcEndpoint } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StartingPosition, LayerVersion, Runtime, Architecture, Code, Handler } from 'aws-cdk-lib/aws-lambda';
import { CfnReplicationSubnetGroup, CfnEndpoint, CfnReplicationInstance, CfnReplicationTask } from 'aws-cdk-lib/aws-dms';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { getPublicIp } from './utils/ip';
import { getUsername } from './utils/username';

// REFER: https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html#retrieving-secrets_lambda_ARNs
const lambdaSecretsLayerArn = 'arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension-Arm64:4' as const;

export function FoldBackendStack({ app, stack }: StackContext) {
    /** Flag that denotes if the stack is running locally in development mode. */
    const IS_LOCAL = app.mode === 'dev';
    /** Public IP address of the currently running machine. */
    let publicIp: string | undefined;

    app.setDefaultFunctionProps({
        logRetention: 'three_days',
    });

    if (app.stage !== 'prod') {
        // TODO: remove this and use DESTORY for all non-prod stuff.
        app.setDefaultRemovalPolicy(RemovalPolicy.RETAIN);
        // app.setDefaultRemovalPolicy(RemovalPolicy.DESTROY);
    }

    if (IS_LOCAL) {
        publicIp = getPublicIp();
    }

    // Use Secrets Manager cache layer to make secrets lookups fast in Lambdas.
    // REFER: https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html
    const secretsCacheLayer = LayerVersion.fromLayerVersionArn(stack, 'ProjectsSecretsLambdaLayer', lambdaSecretsLayerArn);

    const vpc = new Vpc(stack, 'ProjectsVPC', {
        vpcName: 'fold-backend-projects-vpc',
        ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
        natGateways: 0,
        enableDnsHostnames: true, // NOTE: Required only if you're using VPC endpoints.
        enableDnsSupport: true, // NOTE: Required only if you're using VPC endpoints.
        maxAzs: 3, // NOTE: Has to be >= 2 for RDS to spin up inside this VPC.
        subnetConfiguration: [
            {
                name: 'fold-backend-projects-subnet-private',
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
            },
            {
                name: 'fold-backend-projects-subnet-public',
                subnetType: SubnetType.PUBLIC,
                cidrMask: 24,
            },
            {
                name: 'fold-backend-projects-subnet-isolated',
                subnetType: SubnetType.PRIVATE_ISOLATED,
                cidrMask: 24,
            },
        ],
    });

    const sg = new SecurityGroup(stack, 'ProjectsSecurityGroup', {
        securityGroupName: 'fold-backend-projects-sg',
        description: 'Security group for Fold backend projects',
        vpc,
        allowAllOutbound: true,
    });
    Tags.of(sg).add('Name', 'fold-backend-projects-sg');

    // Create custom RDS parameter group for PG DB to enable logical replication so DMS can pick up CDC.
    const dbVersion = 13 as const // NOTE: Not using 14.x because it requires DMS engine 3.4.7, which isn't working with private subnets.
    const dbParameterGroup = new ParameterGroup(stack, 'ProjectsDatabaseParamGroup', {
        engine: {
            engineType: 'postgresql',
            parameterGroupFamily: `postgres${dbVersion}`,
        },
        parameters: {
            // REFER: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html
            // REFER: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.html
            // This is required for logical replication (and thereby CDC) to work.
            'shared_preload_libraries': 'pg_stat_statements,pglogical',
            'rds.logical_replication': '1',
        },
        description: 'Default parameters but modified for logical replication (for CDC to work)',
    });

    // Create PostgreSQL DB.
    const dbEngine = DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion[`VER_${dbVersion}`] });
    const dbInstanceType = InstanceType.of(InstanceClass.T3, InstanceSize.MICRO);
    const dbPort = 5432 as const;
    const dbName = 'folddb' as const;

    const dbMasterSecret = new Secret(stack, 'ProjectsDBMasterSecret', {
        secretName: 'fold-backend-projects-db-master-secret',
        description: 'PostgreSQL database master user credentials',
        generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: 'postgres' }),
            generateStringKey: 'password',
            passwordLength: 32,
            excludePunctuation: true,
        },
    });

    sg.addIngressRule(
        Peer.ipv4(vpc.vpcCidrBlock),
        Port.tcp(dbPort),
        `Allow port ${dbPort} for database connections from only within this VPC`,
    );

    // Configure rules so the Trigger lambda can access RDS.
    // REFER: https://aws.amazon.com/premiumsupport/knowledge-center/connect-lambda-to-an-rds-instance/
    new CfnSecurityGroupIngress(stack, 'ProjectsVPCSGInitIngressRule', {
        groupId: sg.securityGroupId,
        sourceSecurityGroupId: sg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: dbPort,
        toPort: dbPort,
    });
    new CfnSecurityGroupEgress(stack, 'ProjectsVPCSGInitEgressRule', {
        groupId: sg.securityGroupId,
        destinationSecurityGroupId: sg.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: dbPort,
        toPort: dbPort,
    });

    if (IS_LOCAL) {
        console.warn(`WARN: Adding network ingress rule to allow DB to be accessed from your public IP address (${publicIp})`);
        sg.addIngressRule(
            Peer.ipv4(`${publicIp}/32`),
            Port.tcp(dbPort),
            `Allow OUTSIDE ACCESS (temporarily) for ${getUsername()}`,
        );
    }

    // Set up VPC endpoint for secrets manager so the trigger Lamdbda
    // can access Secrets Manager. Why? By default, Lambdas are placed
    // in their own private VPC which does not have access to the outside.
    const vpcSMEndpoint = new InterfaceVpcEndpoint(stack, 'ProjectsVPCSMEndpoint', {
        vpc,
        service: {
            name: `com.amazonaws.${app.region}.secretsmanager`,
            port: 443,
            privateDnsDefault: true,
        },
        open: true,
    });
    Tags.of(vpcSMEndpoint).add('Name', 'fold-backend-projects-vpc-secretsmanager-ep');

    vpcSMEndpoint.addToPolicy(new PolicyStatement({
        sid: 'AllowReadAccessToSecretsManager',
        principals: [
            new AccountPrincipal(app.account),
        ],
        actions: [
            'secretsmanager:GetSecretValue',
        ],
        effect: Effect.ALLOW,
        resources: [
            dbMasterSecret.secretArn,
        ],
    }));

    const db = new DatabaseInstance(stack, 'ProjectsDatabase', {
        instanceIdentifier: 'fold-backend-pg-db',
        vpc,
        vpcSubnets: {
            subnetType: SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [sg],
        instanceType: dbInstanceType,
        engine: dbEngine,
        port: dbPort,
        databaseName: dbName,
        credentials: Credentials.fromSecret(dbMasterSecret),
        backupRetention: Duration.days(IS_LOCAL ? 0 : 14), // Disable snapshot backups during local development alone to save costs.
        deleteAutomatedBackups: IS_LOCAL ? true : false,
        parameterGroup: dbParameterGroup,
        storageEncrypted: true,
    });

    if (IS_LOCAL) {
        console.warn(`WARN: Adding database connection rule to allow DB to be accessed from your public IP address (${publicIp})`);
        db.connections.allowFrom(
            Peer.ipv4(`${publicIp}/32`),
            Port.tcp(dbPort),
            `Allow OUTSIDE ACCESS (temporarily) for ${getUsername()}`,
        );
    }

    // Create the DB CDC capture stream.
    const stream = new KinesisStream(stack, 'ProjectsCDCStream');
    const streamConstruct = Stream.fromStreamArn(stack, 'ProjectsCDCKinesisLookup', stream.streamArn)

    const streamHandlerFunctionName = 'fold-backend-cdc-kinesis-stream-handler' as const
    const streamHandler = new Function(stack, 'ProjectsCDCStreamHandler', {
        functionName: streamHandlerFunctionName,
        architecture: Architecture.ARM_64,
        layers: [secretsCacheLayer],
        runtime: Runtime.NODEJS_18_X.toString(),
        description: 'Lambda function that is triggered for records on the Kinesis CDC stream from DMS',
        handler: 'packages/functions/src/pg-cdc-kinesis.main',
        url: false,
        logRetention: 'three_days',
    });
    streamHandler.addPermission('ProjectsCDCKinesisLambdaInvokePermission', {
        principal: new ArnPrincipal(streamHandler.role?.roleArn as string),
    });

    streamHandler.addEventSource(new KinesisEventSource(streamConstruct, {
        startingPosition: StartingPosition.TRIM_HORIZON,
    }));

    const kinesisCDCConsumerRole = new Role(stack, 'ProjectsKinesisCDCConsumerIAMRole', {
        roleName: 'fold-backend-kinesis-cdc-consumer-role',
        description: 'IAM role that lets the DMS target endpoint write to Kinesis',
        assumedBy: new ServicePrincipal('dms.amazonaws.com'),
    });

    const kinesisCDCWriteStatements = [
        new PolicyStatement({
            sid: 'WriteCDCToKinesis',
            effect: Effect.ALLOW,
            actions: [
                'kinesis:DescribeStream',
                'kinesis:PutRecord',
                'kinesis:PutRecords',
            ],
            resources: [
                stream.streamArn,
            ],
        }),
    ];

    const kinesisWritePolicy = new Policy(stack, 'ProjectsKinesisWriteIAMPolicy', {
        policyName: 'fold-backend-kinesis-write-policy',
        statements: kinesisCDCWriteStatements,
    });
    kinesisWritePolicy.attachToRole(kinesisCDCConsumerRole);

    // Create the CDC infra.
    db.grantConnect(new ServicePrincipal('dms.amazonaws.com'));

    const dmsVpcIamRole = new Role(stack, 'ProjectsDMSVPCManageIamRole', {
        roleName: 'fold-backend-dms-vpc-manage-role',
        description: 'Allow DMS to manage VPC',
        managedPolicies: [
            // REFER: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dms_replication_subnet_group
            ManagedPolicy.fromManagedPolicyArn(stack, 'ProjectsDMSVPCManagedPolicyLookup', 'arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole')
        ],
        assumedBy: new ServicePrincipal('dms.amazonaws.com'),
    });

    const dmsSourceEndpoint = new CfnEndpoint(stack, 'ProjectsDMSDBSourceEndpoint', {
        endpointType: 'source',
        engineName: 'postgres',
        endpointIdentifier: 'fold-backend-projects-dms-source-ep-pgsql',
        databaseName: dbName,
        port: dbPort,
        serverName: db.dbInstanceEndpointAddress,
        username: Credentials.fromSecret(dbMasterSecret).username,
        password: Credentials.fromSecret(dbMasterSecret).password?.toString(),
        sslMode: 'require',
    });

    const dmsTargetEndpoint = new CfnEndpoint(stack, 'ProjectsDMSKinesisTargetEndpoint', {
        endpointType: 'target',
        engineName: 'kinesis',
        endpointIdentifier: 'fold-backend-projects-dms-target-ep-kinesis',
        kinesisSettings: {
            streamArn: stream.streamArn,
            messageFormat: 'json',
            serviceAccessRoleArn: kinesisCDCConsumerRole.roleArn,
        },
    });

    // NOTE: Need this explicitly set up to make sure the replication instance is put in the correct VPC (i.e. same VPC as database).
    // Why? SEE: https://github.com/hashicorp/terraform-provider-aws/issues/7602
    const dmsReplicationSubnetGroup = new CfnReplicationSubnetGroup(stack, 'ProjectsDMSReplicationSubnetGroup', {
        replicationSubnetGroupDescription: 'Subnet group for DMS replication',
        subnetIds: db.vpc.selectSubnets({
            subnetType: IS_LOCAL ? SubnetType.PUBLIC : SubnetType.PRIVATE_ISOLATED
        }).subnetIds,
    });
    dmsReplicationSubnetGroup.node.addDependency(dmsVpcIamRole);

    const dmsReplicationInstance = new CfnReplicationInstance(stack, 'ProjectsDMSReplicationInstance', {
        replicationInstanceClass: 'dms.t3.micro',
        replicationInstanceIdentifier: 'fold-backend-dms-replicator',
        engineVersion: '3.4.6', // Use 3.4.6 for now, as 3.4.7 needs more complex networking rules to work properly. 
        multiAz: false,
        allocatedStorage: 10,
        publiclyAccessible: false,
        autoMinorVersionUpgrade: false,
        allowMajorVersionUpgrade: false,
        vpcSecurityGroupIds: [sg.securityGroupId],
        replicationSubnetGroupIdentifier: dmsReplicationSubnetGroup.ref,
    });
    dmsReplicationInstance.node.addDependency(dmsReplicationSubnetGroup);

    const dmsReplicationTask = new CfnReplicationTask(stack, 'ProjectsDMSReplicationTask', {
        migrationType: 'full-load-and-cdc',
        replicationTaskIdentifier: 'fold-backend-dms-cdc-postgresql-to-kinesis',
        replicationInstanceArn: dmsReplicationInstance.ref,
        sourceEndpointArn: dmsSourceEndpoint.ref,
        targetEndpointArn: dmsTargetEndpoint.ref,
        replicationTaskSettings: JSON.stringify({
            Logging: {
                EnableLogging: true,
                EnableLogContext: false,
            },
            ControlTablesSettings: {
                // Track all CDC status right inside the source database,
                // but within a custom schema; makes it easier to track CDC progress via SQL.
                ControlSchema: 'aws_dms',
                StatusTableEnabled: true,
                SuspendedTablesTableEnabled: true,
                HistoryTableEnabled: true,
                FullLoadExceptionTableEnabled: true,
            },
            BeforeImageSettings: {
                // Set to `true` to get the before image in CDC data.
                // REFER: https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Tasks.CustomizingTasks.TaskSettings.BeforeImage.html
                EnableBeforeImage: true,
                FieldName: 'before-image',
                ColumnFilter: 'all',
            },
        }),
        tableMappings: JSON.stringify({
            rules: [
                {
                    'rule-type': 'selection',
                    'rule-id': '1',
                    'rule-name': 'passthrough-everything',
                    // Capture all tables but only in the `public` schema.
                    'object-locator': {
                        'schema-name': 'public',
                        'table-name': '%'
                    },
                    'rule-action': 'include',
                }
            ],
        }),
    });

    // Set up OpenSearch.
    // Uses master username-password basic authentication.
    // TODO: Tighter auth policy.
    const searchMasterUsername = 'admin' as const
    const openSearchMasterSecret = new Secret(stack, 'ProjectsOSMasterSecret', {
        secretName: 'fold-backend-projects-opensearch-master-secret',
        description: 'OpenSearch domain master user credentials',
        generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: searchMasterUsername }),
            generateStringKey: 'password',
            passwordLength: 32,
            requireEachIncludedType: true,
        },
    });

    const search = new Domain(stack, 'ProjectsSearch', {
        domainName: 'fold-backend-search-domain',
        version: EngineVersion.OPENSEARCH_2_3,
        // NOTE: these values are only for experiments, and not tuned for production.
        capacity: {
            dataNodeInstanceType: 't3.small.search',
            dataNodes: 1,
        },
        ebs: {
            enabled: true,
            volumeType: EbsDeviceVolumeType.GP2,
            volumeSize: 10,
        },
        encryptionAtRest: {
            enabled: true
        },
        useUnsignedBasicAuth: true,
        fineGrainedAccessControl: {
            masterUserName: openSearchMasterSecret.secretValueFromJson('username').toString(),
            masterUserPassword: openSearchMasterSecret.secretValueFromJson('password'),
        },
        enableVersionUpgrade: false,
        nodeToNodeEncryption: true,
        enforceHttps: true,
        vpc: undefined,
        accessPolicies: [
            new PolicyStatement({
                sid: 'AllowEverything',
                principals: [
                    new AnyPrincipal(),
                ],
                actions: [
                    'es:*',
                ],
                effect: Effect.ALLOW,
            }),
        ],
    });

    const api = new Api(stack, 'ProjectsApi', {
        defaults: {
            function: {
                functionName: 'fold-backend-projects-api-handler',
                description: 'Lambda function that handles all API calls to Projects data',
                architecture: Architecture.ARM_64,
                runtime: Runtime.NODEJS_18_X.toString(),
                layers: [
                    secretsCacheLayer,
                ],
                environment: {
                    OPENSEARCH_DOMAIN_ENDPOINT: search.domainEndpoint,
                    OPENSEARCH_MASTER_CREDENTIALS_SECRET_ID: openSearchMasterSecret.secretName,
                },
                permissions: [
                    new PolicyStatement({
                        sid: 'AllowLambdaToAccessOpenSearch',
                        actions: [
                            'es:Http*',
                        ],
                        resources: [
                            search.domainArn
                        ]
                    }),
                ],
            },
        },
        routes: {
            'GET /projects': 'packages/functions/src/projects-get.main',
            // 'GET /projects/{userId}': 'packages/functions/src/projects-lookup.main',
        },
        accessLog: {
            retention: 'three_days',
        },
    });
    /** `Function` construct for the `GET /projects` Lambda handler function. */
    const apiFunction = api.getFunction('GET /projects') as Function;

    openSearchMasterSecret.grantRead(Role.fromRoleArn(stack, 'ProjectsApiHandlerExecRoleLookup', apiFunction.role?.roleArn as string));

    // Allow Kinesis CDC stream handler to read OpenSearch secrets
    // so it can write CDC data to OpenSearch.
    streamHandler.addEnvironment('OPENSEARCH_MASTER_CREDENTIALS_SECRET_ID', openSearchMasterSecret.secretName);
    openSearchMasterSecret.grantRead(Role.fromRoleArn(stack, 'ProjectsStreamHandlerExecRoleLookup', streamHandler.role?.roleArn as string));

    // Set up DB initializer.
    // This handles initial DB bootstrapping (like installing PostgreSQL extensions for CDC).
    const dbInit = new TriggerFunction(stack, 'ProjectsDbInitHandler', {
        functionName: 'fold-backend-db-init-lambda-trigger',
        description: 'Lambda function that is triggered when the database is initialized',
        timeout: Duration.seconds(15),
        runtime: Runtime.FROM_IMAGE,
        architecture: Architecture.X86_64,
        code: Code.fromAssetImage('stacks/triggers/db-init', {
            platform: Platform.LINUX_AMD64,
        }),
        handler: Handler.FROM_IMAGE,
        vpc: db.vpc,
        vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        logRetention: RetentionDays.THREE_DAYS,
        environment: {
            DB_HOST: db.dbInstanceEndpointAddress,
            DB_PORT: db.dbInstanceEndpointPort,
            DB_NAME: dbName,
            DB_SECRET_ID: dbMasterSecret.secretName,
        },
        executeAfter: [
            db,
            dbParameterGroup,
            vpcSMEndpoint,
        ],
        executeBefore: [
            // Make sure DB initialization is completed _before_ DMS can start CDC replication.
            dmsReplicationInstance,
            dmsReplicationTask,
            // Add other non-dependencies that take too long to provision/re-provision.
            // This helps save time waiting for CloudFormation to rollback when something goes wrong in this trigger.
            // dbProxy,
            search,
            Function.fromFunctionArn(stack, 'ProjectsGetAPIFunctionLookup', apiFunction.functionArn as string),
            streamHandler,
            streamConstruct,
            dmsSourceEndpoint,
            dmsTargetEndpoint,
            dmsReplicationSubnetGroup,
        ],
    });
    dbInit.addPermission('ProjectsDbInitHandlerInvokePermission', {
        principal: new ArnPrincipal(dbInit.role?.roleArn as string),
    });
    dbMasterSecret.grantRead(Role.fromRoleArn(stack, 'ProjectsDbInitHandlerExecRoleLookup', dbInit.role?.roleArn as string));
    vpcSMEndpoint.connections.allowFrom(dbInit, Port.allTcp());

    // Show important values in output.
    stack.addOutputs({
        DatabaseEndpoint: db.dbInstanceEndpointAddress,
        VpcId: vpc.vpcId,
        DatabaseVpcId: db.vpc.vpcId,
        ApiEndpoint: api.url,
        OpenSearchDomainEndpoint: search.domainEndpoint,
        DmsReplicationTaskArn: dmsReplicationTask.ref,
    });

    // Add tags for easier tracking of resources.
    const defaultTags: Record<string, string> = {
        ManagedBy: 'Fold-Backend-Stack',
        Team: 'Platform',
        Contact: 'me@httgp.com',
    };

    Object.entries(defaultTags).forEach(([key, value]) => {
        Tags.of(stack).add(key, value, {
            applyToLaunchedInstances: true,
        })
    });
}
