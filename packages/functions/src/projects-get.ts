import got from 'got';
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

export const main: APIGatewayProxyHandlerV2 = async (_event) => {
    const osEndpoint = process.env.OPENSEARCH_DOMAIN_ENDPOINT;
    const osUsername = process.env.OPENSEARCH_MASTER_USERNAME;
    const osPassword = process.env.OPENSEARCH_MASTER_PASSWORD;
    const osIndex = 'projects' as const

    const url = `https://${osEndpoint}/${osIndex}/_search?pretty=true&q=*:*`
    const searchResponse = await request.get(url, {
        username: osUsername,
        password: osPassword,
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
