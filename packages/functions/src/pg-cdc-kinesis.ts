import got, { type Method } from 'got';
import type { KinesisStreamEvent } from 'aws-lambda';

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

export const main = async (event: KinesisStreamEvent) => {
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
    
    const osEndpoint = process.env.OPENSEARCH_DOMAIN_ENDPOINT;
    const osUsername = process.env.OPENSEARCH_MASTER_USERNAME;
    const osPassword = process.env.OPENSEARCH_MASTER_PASSWORD;
    const osOps = cdcRecords.flatMap(record => {
        const osIndex = record.metadata['table-name'];
        const recordId = record.data.id as number;
        const operationType = record.metadata.operation;
        const method = osMethodOperationMap[operationType];

        if (operationType === 'insert' || 'delete' || 'update') {
            const url = `https://${osEndpoint}/${osIndex}/_doc/${recordId}`
            const op = request(url, {
                method,
                username: osUsername,
                password: osPassword,
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
        console.info(`Going to execute ${osOps.length} operation(s) on OpenSearch...`);
        const osResults = await Promise.all(osOps.map(_ => _.operation));
        console.info(`Finished executing ${osOps.length} operation(s) on OpenSearch!`);
        for (const [index, osResult] of osResults.entries()) {
            const opMeta = osOps[index];
            console.info(`OpenSearch response for ${opMeta.operationType} (HTTP ${opMeta.method}) operation on ${opMeta.index}/${opMeta.recordId}`, osResult.statusCode, osResult.body);
        }
    } else {
        console.debug(`No OpenSearch operations to perform!`)
    }
    return Promise.resolve();
};
