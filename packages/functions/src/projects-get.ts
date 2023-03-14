import got from 'got';
import { z } from 'zod';
import { getCredentials } from './utils/get-secret';
import type { SearchResponse } from 'elasticsearch';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

interface Project {
    id: number
    name: string
    slug: string
    desciption?: string
    created_at: string
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

export const main: APIGatewayProxyHandlerV2 = async (_event) => {
    const { OPENSEARCH_DOMAIN_ENDPOINT: osEndpoint, OPENSEARCH_MASTER_CREDENTIALS_SECRET_ID: osSecretId } = envSchema.parse(process.env);
    const { username, password } = await getCredentials(osSecretId);
    const osIndex = 'projects' as const

    const url = `https://${osEndpoint}/${osIndex}/_search?pretty=true&q=*:*`;
    const searchResponse = await request.get(url, {
        username,
        password,
    }).json<SearchResponse<Project>>();

    const response = searchResponse.hits.hits.map(hit => hit._source);
    const responseAsString = JSON.stringify(response);

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(responseAsString),
        },
        body: responseAsString,
    };
};
