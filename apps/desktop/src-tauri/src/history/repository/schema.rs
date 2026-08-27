use rusqlite::Connection;

pub(super) fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_statement: &str,
) -> Result<(), String> {
    let columns = table_columns(connection, table)?;
    if !columns.iter().any(|value| value == column) {
        connection
            .execute(alter_statement, [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn table_columns(
    connection: &Connection,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}
