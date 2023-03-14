import {
	GetSecretValueCommand,
	type GetSecretValueCommandInput,
	type GetSecretValueCommandOutput,
	SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import got from 'got';
import type { MergeExclusive } from 'type-fest';

interface Credentials {
	username: string;
	password: string;
}

const request = got.extend({
	throwHttpErrors: true,
	responseType: 'json',
});

const getSecretFromSecretsCache = async (
	sessionToken: string,
	secretsPort: number,
	secretId: string,
	version?: MergeExclusive<{ versionId: string; }, { versionStage: string; }>,
): Promise<string | undefined> => {
	const baseUrl = new URL(`http://localhost:${secretsPort}/secretsmanager/get?secretId=${secretId}`);
	if (version?.versionId) {
		baseUrl.searchParams.append('versionId', version.versionId);
	}
	if (version?.versionStage) {
		baseUrl.searchParams.append('versionStage', version.versionStage);
	}

	const secretsResponse = await request(baseUrl.toString(), {
		headers: {
			'X-Aws-Parameters-Secrets-Token': sessionToken,
		},
	})
		.json<GetSecretValueCommandOutput>();

	return secretsResponse.SecretString;
};

/**
 * Fetches secret value in plaintext from Secrets Manager.
 *
 * Intelligently tries to fetch credentials from the Secrets Manager cache layer ([read more](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html))
 * and if that fails, it falls back to fetching them directly from Secrets Manager.
 *
 * @param secretId Secret ID.
 * @param version (Optional) Version ID or Version stage of the Lambda to use.
 * @returns {string} Plaintext value of secret.
 */
const getSecret = async (
	secretId: string,
	version?: MergeExclusive<{ versionId: string; }, { versionStage: string; }>,
): Promise<string | undefined> => {
	if (!secretId) {
		throw new Error('Secret ID not provided, cannot lookup secret!');
	}
	const sessionToken = process.env.AWS_SESSION_TOKEN;
	const port = parseInt(process.env.PARAMETERS_SECRETS_EXTENSION_HTTP_PORT as string, 10);

	if (!sessionToken || !port) {
		console.warn(
			`Secrets Manager cache layer not configured${
				!port ? ' (correctly)' : ''
			}, falling back to getting secret via API from Secrets Manager.`,
		);
		console.warn(
			'Tip: Consider adding a cache layer to improve your Lambda response times! See https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html for more information.',
		);

		const smClient = new SecretsManagerClient({
			region: process.env.AWS_REGION,
		});
		const params: GetSecretValueCommandInput = {
			SecretId: secretId,
		};
		try {
			const response = await smClient.send(new GetSecretValueCommand(params));
			return response.SecretString;
		} catch (err) {
			console.error(`Could not fetch secret ID ${secretId}`);
			throw err;
		}
	} else {
		const secret = await getSecretFromSecretsCache(sessionToken, port, secretId, version);
		return secret;
	}
};

/**
 * Fetches credentials from Secrets Manager.
 *
 * Assumes that the credentials are saved as a JSON in the format –
 *
 * ```json
 * {
 *   "username": "<string>",
 *   "password": "<string>"
 * }
 *
 * Intelligently tries to fetch credentials from the Secrets Manager cache layer ([read more](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html))
 * and if that fails, it falls back to fetching them directly from Secrets Manager.
 *
 * If you're looking to access the secret value in plaintext (perhaps because your secret is not in the above format),
 * use the {@link getSecret} method.
 * ```
 * @param secretId Secret ID.
 * @param version (Optional) Version ID or Version stage of the Lambda to use.
 * @returns {Credentials} Credentials
 */
export const getCredentials = async (
	secretId: string,
	version?: MergeExclusive<{ versionId: string; }, { versionStage: string; }>,
): Promise<Credentials> => {
	const credentialsPlaintext = await getSecret(secretId, version);
	if (!credentialsPlaintext) {
		throw new Error('Credentials not found in Secrets Manager!');
	}
	return JSON.parse(credentialsPlaintext) satisfies Credentials;
};
