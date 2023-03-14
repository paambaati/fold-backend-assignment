import got, { type Method } from 'got';
import { z } from 'zod';
import { getCredentials } from './utils/get-secret';
import type { KinesisStreamHandler } from 'aws-lambda';

export interface DMSCDCData {
    /** Actual database record. */
    data: {
        id: number,
        [key: string]: string | number | boolean | null,
    },
    metadata: {
        operation: 'insert' | 'update' | 'delete'
        'partition-key-type': 'schema-table'
        'record-type': 'data'
        'schema-name': string
        'table-name': typeof FOLD_TABLES[number] | string
        'timestamp': string
        'transaction-id': number
    },
}

const request = got.extend({
    throwHttpErrors: true,
    responseType: 'json',
});

const validStringSchema = z.string().nonempty();
const envSchema = z.object({
    OPENSEARCH_DOMAIN_ENDPOINT: validStringSchema,
    OPENSEARCH_MASTER_CREDENTIALS_SECRET_ID: validStringSchema,
});

const osMethodOperationMap: Record<DMSCDCData['metadata']['operation'][number], Method> = {
    'insert': 'PUT',
    'update': 'POST',
    'delete': 'DELETE'
} as const;

const FOLD_TABLES = [
    'users',
    'projects',
    'hashtags',
    'project_hashtags',
    'user_projects'
];

export const main: KinesisStreamHandler = async (event) => {
    console.debug(`Received Kinesis event from DMS with ${event.Records.length} record(s)`);
    console.debug(JSON.stringify(event.Records));
    const cdcRecords: Array<DMSCDCData> = []
    for (const record of event.Records) {
        const payload = record.kinesis.data;
        const cdcRecord: DMSCDCData = JSON.parse(Buffer.from(payload, 'base64').toString()) satisfies DMSCDCData;
        console.info(cdcRecord);
        if (cdcRecord.metadata['record-type'] === 'data' && FOLD_TABLES.includes(cdcRecord.metadata['table-name'])) {
            cdcRecords.push(cdcRecord);
        }
    }
    
    const { OPENSEARCH_DOMAIN_ENDPOINT: osEndpoint, OPENSEARCH_MASTER_CREDENTIALS_SECRET_ID: osSecretId } = envSchema.parse(process.env);
    const { username, password } = await getCredentials(osSecretId);
    const osOps = cdcRecords.flatMap(record => {
        const osIndex = record.metadata['table-name'];
        const recordId = record.data.id as number;
        const operationType = record.metadata.operation;
        const method = osMethodOperationMap[operationType];

        if (operationType === 'insert' || 'delete' || 'update') {
            const url = `https://${osEndpoint}/${osIndex}/_doc/${recordId}`
            const op = request(url, {
                method,
                username,
                password,
                throwHttpErrors: operationType === 'delete' ? false : undefined,
                json: operationType === 'delete' ? undefined : record.data,
            });
            return {
                index: osIndex,
                recordId,
                method,
                operationType,
                operation: op,
            }
        } else {
            return []
        }
    });

    if (osOps.length) {
        console.info(`Going to execute ${osOps.length} operation(s) (out of ${cdcRecords.length} records total) on OpenSearch...`);
        const osResults = await Promise.all(osOps.map(_ => _.operation));
        console.info(`Finished executing ${osResults.length} operation(s) on OpenSearch!`);
        for (const [index, osResult] of osResults.entries()) {
            const opMeta = osOps[index];
            console.info(`OpenSearch response for ${opMeta.operationType} (HTTP ${opMeta.method}) operation on ${opMeta.index}/${opMeta.recordId}`, osResult.statusCode, osResult.body);
        }
    } else {
        console.debug(`No OpenSearch operations to perform!`)
    }
    return Promise.resolve();
};
