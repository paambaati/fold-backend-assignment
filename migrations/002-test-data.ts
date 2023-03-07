import { Logger } from "sst/logger"
import type { Kysely } from "kysely"
import type { FoldProjectsDatabase } from './001-initial';

const users = [
    "Shakti",    
    "Akash",
    "Utkarsh",
] as const

async function up(db: Kysely<FoldProjectsDatabase>) {
    Logger.debug('Up migrations started!', __filename);
    for (const user in users) {
        await db.insertInto("users")
        .values({ name: user })
        .execute()
    }
    Logger.debug('Up migrations completed!', __filename);
}

async function down(db: Kysely<unknown>) {
    Logger.debug('Down migrations started!', __filename);
    for (const user in users) {
        await db.deleteFrom("users").where("users.name", "=", user).execute()
    }
    Logger.debug('Down migrations completed!', __filename);
}

module.exports = { up, down };
