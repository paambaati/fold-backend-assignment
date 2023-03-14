import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { hrtime } from 'node:process';
import pTimeout from 'p-timeout';
import pg from 'postgres';
import { z } from 'zod';

const validStringSchema = z.string().nonempty();
const envSchema = z.object({
	DB_HOST: validStringSchema,
	DB_PORT: validStringSchema,
	DB_NAME: validStringSchema,
	DB_SECRET_ID: validStringSchema,
});

const getSecretValue = async (/** @type {string} */ secretId) => {
	const secretsClient = new SecretsManagerClient({
		region: process.env.AWS_REGION,
	});
	const params = {
		SecretId: secretId,
	};
	const command = new GetSecretValueCommand(params);
	try {
		const data = await secretsClient.send(command);
		/** @type {{ username: String, password: string }} */
		const secret = JSON.parse(validStringSchema.parse(data.SecretString));
		return secret;
	} catch (error) {
		console.error('Error fetching secret from Secrets Manager!', error);
		throw error;
	}
};

/**
 * Connects to the PostgreSQL database instance and executes the `script.sql` file.
 */
export const handler = async () => {
	console.info('Database init lambda triggered!');
	const { DB_HOST, DB_PORT, DB_NAME, DB_SECRET_ID } = envSchema.parse(process.env);
	const port = parseInt(DB_PORT, 10);

	console.info('Connecting to Secrets Manager to fetch database credentials...', {
		secretId: DB_SECRET_ID,
	});
	const { username, password } = await pTimeout(getSecretValue(DB_SECRET_ID), {
		milliseconds: 5 * 1000,
		message: 'Timeout error connecting to Secrets Manager!',
	});

	/** @type { pg.Options<Record<string, any>> } */
	const pgOptions = {
		host: DB_HOST,
		port,
		username,
		password,
		database: DB_NAME,
		connect_timeout: 5,
		ssl: 'prefer',
	};
	console.info('Connecting to PostgreSQL database instance...', {
		...pgOptions,
		password: '*****',
	});
	const sql = pg(pgOptions);
	const startTime = hrtime.bigint();
	const result = await pTimeout(sql.file('script.sql'), {
		milliseconds: 10 * 1000,
		message: 'Timeout error connecting to PostgreSQL database!x',
	});
	const endTime = hrtime.bigint();
	console.info('Database init SQL script finished executing!', {
		result: JSON.stringify(result),
		sqlExecutionDuration: `${Number(endTime - startTime) / 1e6} ms`,
	});
	sql.end().catch(() => {});
	return;
};
