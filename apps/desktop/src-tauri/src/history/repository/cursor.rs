pub(super) fn decode_session_cursor(
    cursor: Option<&str>,
) -> Result<(Option<i64>, Option<String>), String> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok((None, None));
    };
    let (time, id) = cursor
        .split_once('|')
        .ok_or_else(|| "无效的历史 session 游标".to_string())?;
    let time = time
        .parse::<i64>()
        .map_err(|_| "无效的历史 session 游标".to_string())?;
    if id.is_empty() {
        return Err("无效的历史 session 游标".to_string());
    }
    Ok((Some(time), Some(id.to_string())))
}

pub(super) fn decode_cue_cursor(cursor: Option<&str>) -> Result<Option<i64>, String> {
    cursor
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| "无效的历史 cue 游标".to_string())
        })
        .transpose()
}
