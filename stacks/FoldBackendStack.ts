import { Api, Function, KinesisStream, StackContext } from 'sst/constructs';
import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Stream } from 'aws-cdk-lib/aws-kinesis';
import { Role, ServicePrincipal, Policy, PolicyStatement, Effect, ManagedPolicy, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { Credentials, DatabaseInstanceEngine, DatabaseInstance, PostgresEngineVersion, ParameterGroup } from 'aws-cdk-lib/aws-rds';
import { InstanceClass, InstanceSize, InstanceType, Vpc, Peer, Port, SecurityGroup, SubnetType, IpAddresses } from 'aws-cdk-lib/aws-ec2';
import { CfnEndpoint, CfnReplicationInstance, CfnReplicationTask, CfnReplicationSubnetGroup } from 'aws-cdk-lib/aws-dms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StartingPosition } from 'aws-cdk-lib/aws-lambda';
// import { CdkResourceInitializer } from './resources/initializer';
// import { DockerImageCode } from 'aws-cdk-lib/aws-lambda';

// TODO: set this to false when deployment is fired on production.
const __UNSAFE_ALLOW_OUTSIDE_ACCESS = true as const

export function FoldBackendStack({ app, stack }: StackContext) {
    if (app.stage !== 'prod') {
        app.setDefaultRemovalPolicy(RemovalPolicy.DESTROY);
    }

    const vpc = new Vpc(stack, 'ProjectsVPC', {
        vpcName: 'Projects-VPC',
        ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
        natGateways: 0,
        maxAzs: 3, // NOTE: Has to be >= 2 for RDS to spin up inside this VPC.
        subnetConfiguration: [
            {
                name: 'private-subnet-1',
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                cidrMask: 24,
            },
            {
                name: 'public-subnet-1',
                subnetType: SubnetType.PUBLIC,
                cidrMask: 24,
            },
            {
                name: 'isolated-subnet-1',
                subnetType: SubnetType.PRIVATE_ISOLATED,
                cidrMask: 24,
            },
        ],
    });

    const sg = new SecurityGroup(stack, 'ProjectsSecurityGroup', {
        securityGroupName: 'Projects-SG',
        description: 'Security group for Fold projects',
        vpc: vpc,
        allowAllOutbound: true,
    });

    // Push everything from SST to use our hand-crafted VPC.
    stack.setDefaultFunctionProps({
        vpc: vpc,
        vpcSubnets: {
            subnets: vpc.privateSubnets,
        },
    });

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

    // Create PostgreSQL DB
    const dbEngine = DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion[`VER_${dbVersion}`] });
    const dbInstanceType = InstanceType.of(InstanceClass.T3, InstanceSize.MICRO);
    const dbPort = 5432 as const;
    const dbName = 'folddb' as const;

    const dbMasterSecret = new Secret(stack, 'ProjectsDBMasterSecret', {
        secretName: 'projects-db-master-secret',
        description: 'PostgreSQL database master user credentials',
        generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: 'postgres' }),
            generateStringKey: 'password',
            passwordLength: 16,
            excludePunctuation: true,
        }
    });

    sg.addIngressRule(
        Peer.ipv4(vpc.vpcCidrBlock),
        Port.tcp(dbPort),
        `Allow port ${dbPort} for database connections from only within this VPC`,
    );

    __UNSAFE_ALLOW_OUTSIDE_ACCESS ? sg.addIngressRule(
        Peer.anyIpv4(),
        Port.tcp(dbPort),
        `Allow OUTSIDE ACCESS (temporarily) from ANYWHERE`
    ) : () => { };

    const db = new DatabaseInstance(stack, 'ProjectsDatabase', {
        vpc: vpc,
        vpcSubnets: {
            subnetType: __UNSAFE_ALLOW_OUTSIDE_ACCESS ? SubnetType.PUBLIC : SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [sg],
        publiclyAccessible: __UNSAFE_ALLOW_OUTSIDE_ACCESS,
        instanceType: dbInstanceType,
        engine: dbEngine,
        port: dbPort,
        databaseName: dbName,
        credentials: Credentials.fromSecret(dbMasterSecret),
        backupRetention: Duration.days(0), // Disable snapshot backups to save cost.
        deleteAutomatedBackups: true,
        removalPolicy: RemovalPolicy.DESTROY,
        parameterGroup: dbParameterGroup,
        storageEncrypted: false,
    });

    __UNSAFE_ALLOW_OUTSIDE_ACCESS ? db.connections.allowFrom(Peer.anyIpv4(), Port.tcp(dbPort)) : () => { };

    // const initializer = new CdkResourceInitializer(stack, 'ProjectsDBInit', {
    //     config: {
    //         credsSecretName: dbMasterSecret.secretName,
    //     },
    //     fnLogRetention: RetentionDays.THREE_DAYS,
    //     fnCode: DockerImageCode.fromImageAsset(`${__dirname}/rds-init-fn-code`, {}),
    //     fnTimeout: Duration.minutes(2),
    //     fnSecurityGroups: [],
    //     vpc,
    //     subnetsSelection: vpc.selectSubnets({
    //         subnetType: SubnetType.PRIVATE_WITH_EGRESS,
    //     }),
    // });
    // initializer.customResource.node.addDependency(db);
    // db.connections.allowFrom(initializer.function, Port.tcp(dbPort))
    // dbMasterSecret.grantRead(initializer.function)

    // Create the DB CDC capture stream.
    const stream = new KinesisStream(stack, 'ProjectsCDCStream');

    const streamHandlerFunctionName = 'fold-backend-cdc-kinesis-stream-handler' as const
    const streamHandler = new Function(stack, 'ProjectsCDCStreamHandler', {
        functionName: streamHandlerFunctionName,
        description: 'Lambda function that is triggered for records on the Kinesis CDC stream from DMS',
        handler: 'packages/functions/src/pg-cdc-kinesis.main',
        url: false,
        logRetention: 'three_days',
        vpc: undefined,
        vpcSubnets: undefined,
    });
    streamHandler.addPermission('ProjectsCDCKinesisLambdaInvokePermission', {
        principal: new ArnPrincipal(streamHandler.role?.roleArn as string),
    });

    streamHandler.addEventSource(new KinesisEventSource(Stream.fromStreamArn(stack, 'ProjectsCDCKinesisLookup', stream.streamArn), {
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
        resourceIdentifier: 'projects-dms-ep-source-pgsql',
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
        resourceIdentifier: 'projects-dms-ep-target-kinesis',
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
        // subnetIds: vpc.publicSubnets.map(s => s.subnetId),
        // TODO: somehow `db.vpc` is still returning only the default VPC :-(
        subnetIds: db.vpc.publicSubnets.map(s => s.subnetId),
    });
    dmsReplicationSubnetGroup.node.addDependency(dmsVpcIamRole);

    const dmsReplicationInstance = new CfnReplicationInstance(stack, 'ProjectsDMSReplicationInstance', {
        replicationInstanceClass: 'dms.t3.micro',
        replicationInstanceIdentifier: 'projects-fold-dms-replicator',
        engineVersion: '3.4.6',
        multiAz: false,
        allocatedStorage: 10,
        publiclyAccessible: false,
        autoMinorVersionUpgrade: false,
        allowMajorVersionUpgrade: false,
        vpcSecurityGroupIds: [sg.securityGroupId],
        replicationSubnetGroupIdentifier: dmsReplicationSubnetGroup.replicationSubnetGroupIdentifier,
    });
    dmsReplicationInstance.node.addDependency(dmsReplicationSubnetGroup);

    const dmsReplicationTask = new CfnReplicationTask(stack, 'ProjectsDMSReplicationTask', {
        migrationType: 'full-load-and-cdc',
        replicationTaskIdentifier: 'projects-fold-dms-cdc-postgresql-to-kinesis',
        replicationInstanceArn: dmsReplicationInstance.ref,
        sourceEndpointArn: dmsSourceEndpoint.ref,
        targetEndpointArn: dmsTargetEndpoint.ref,
        replicationTaskSettings: JSON.stringify({
            Logging: {
                EnableLogging: true,
                EnableLogContext: false,
            },
            ControlTablesSettings: {
                // Track all CDC status right inside the source table,
                // but within a custom schema. Makes it easier to track CDC progress via SQL.
                ControlSchema: 'aws_dms',
                StatusTableEnabled: true,
                SuspendedTablesTableEnabled: true,
                HistoryTableEnabled: true,
                FullLoadExceptionTableEnabled: true,
              },
        }),
        tableMappings: JSON.stringify({
            rules: [
                {
                    'rule-type': 'selection',
                    'rule-id': '1',
                    'rule-name': 'passthrough-everything',
                     // Capture all public tables
                    'object-locator': {
                        'schema-name': 'public', 
                        'table-name': '%'
                    },
                    'rule-action': 'include',
                }
            ],
        }),
    });

    const api = new Api(stack, 'ProjectsApi', {
        defaults: {
            function: {
                vpc: undefined,
                vpcSubnets: undefined,
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

    // Show important values in output.
    stack.addOutputs({
        DatabaseEndpoint: db.dbInstanceEndpointAddress,
        DatabaseSecretArn: dbMasterSecret.secretArn,
        KinesisStreamArn: stream.streamArn,
        KinesisStreamHandlerLambdaArn: streamHandler.functionArn,
        DmsReplicationTaskArn: dmsReplicationTask.ref,
        VpcId: vpc.vpcId,
        DatabaseVpcId: db.vpc.vpcId,
        ApiEndpoint: api.url,
        // DatabaseInitResponse: Token.asString(initializer.response),
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
