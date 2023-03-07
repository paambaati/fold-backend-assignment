import { Logger } from "sst/logger"
import { sql } from "kysely"
import type { Kysely, Generated, ColumnType } from "kysely"

interface UsersTable {
    id: Generated<number>
    name: string
    created_at: ColumnType<Date, Date | undefined, never>
}

interface HashtagsTable {
    id: Generated<number>
    name: string
    created_at: ColumnType<Date, Date | undefined, never>
}

interface ProjectsTable {
    id: Generated<number>
    name: string
    slug: string
    description: string
    created_at: ColumnType<Date, Date | undefined, never>
}

interface ProjectHashtagsTable {
    hashtag_id: number
    project_id: number
}

interface UserProjectsTable {
    project_id: number
    user_id: number
}

export interface FoldProjectsDatabase {
    users: UsersTable
    hashtags: HashtagsTable
    projects: ProjectsTable
    projectHashtags: ProjectHashtagsTable
    userProjects: UserProjectsTable
}

async function up(db: Kysely<FoldProjectsDatabase>) {
    Logger.debug('Up migrations started!', __filename);
    const logicalPluginInstall = sql`CREATE EXTENSION IF NOT EXISTS pglogical;`
    await logicalPluginInstall.execute(db);
    await db.schema
        .createTable("users")
        .addColumn("id", "bigserial", (col) => col.primaryKey())
        .addColumn("name", "varchar", (col) => col.notNull())
        .addColumn("created_at", "timestamp", (col) => col.defaultTo(sql`NOW()`))
        .execute();

    await db.schema
        .createTable("hashtags")
        .addColumn("id", "bigserial", (col) => col.primaryKey())
        .addColumn("name", "varchar")
        .addColumn("created_at", "timestamp", (col) => col.defaultTo(sql`NOW()`))
        .execute();

    await db.schema
        .createTable("projects")
        .addColumn("id", "bigserial", (col) => col.primaryKey())
        .addColumn("name", "varchar")
        .addColumn("slug", "varchar")
        .addColumn("description", "varchar")
        .addColumn("created_at", "timestamp", (col) => col.defaultTo(sql`NOW()`))
        .execute();

    await db.schema
        .createTable("project_hashtags")
        .addColumn('hashtag_id', 'integer', (col) =>
            col.references('hashtags.id').onDelete('cascade').notNull()
        )
        .addColumn('project_id', 'integer', (col) =>
            col.references('projects.id').onDelete('cascade').notNull()
        )
        .execute();

    await db.schema
        .createTable("user_projects")
        .addColumn('project_id', 'integer', (col) =>
            col.references('projects.id').onDelete('cascade').notNull()
        )
        .addColumn('user_id', 'integer', (col) =>
            col.references('users.id').onDelete('cascade').notNull()
        )
        .execute();

    Logger.debug('Up migrations completed!', __filename);
}

async function down(db: Kysely<FoldProjectsDatabase>) {
    Logger.debug('Down migrations started!', __filename);
    await db.schema.dropTable("users").execute();
    await db.schema.dropTable("hashtags").execute();
    await db.schema.dropTable("projects").execute();
    await db.schema.dropTable("project_hashtags").execute();
    await db.schema.dropTable("user_projects").execute();
    Logger.debug('Down migrations completed!', __filename);
}

module.exports = { up, down };
