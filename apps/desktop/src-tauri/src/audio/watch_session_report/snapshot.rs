use super::*;

pub(super) fn empty_cue(cue_id: &str, revision: u64, route_direction: &str) -> WatchCueComparisonRuntime {
    WatchCueComparisonRuntime {
        cue_id: cue_id.to_string(),
        revision,
        sequence: 0,
        translation_state: Some(SubtitleTranslationStateRuntime::Pending),
        route_direction: if route_direction == "outbound" {
            "outbound".to_string()
        } else {
            "inbound".to_string()
        },
        translation_path: String::new(),
        source_text: String::new(),
        llm_text: String::new(),
        published_text: String::new(),
        published_segments: Vec::new(),
        rendered_source_text: String::new(),
        rendered_text: String::new(),
        comparison_status: "pending".to_string(),
        audio_started_at_ms: None,
        audio_start_origin: None,
        source_stable_at_ms: None,
        source_at_ms: None,
        llm_first_at_ms: None,
        llm_final_at_ms: None,
        published_first_at_ms: None,
        published_final_at_ms: None,
        rendered_first_at_ms: None,
        rendered_final_at_ms: None,
        source_to_llm_first_ms: None,
        source_to_render_ms: None,
        llm_first_to_publish_ms: None,
        publish_to_render_ms: None,
        llm_first_to_render_ms: None,
        llm_final_to_publish_ms: None,
        published_final_to_render_ms: None,
        llm_final_to_render_ms: None,
        audio_to_source_first_ms: None,
        audio_to_llm_first_ms: None,
        audio_to_render_first_ms: None,
        audio_to_render_final_ms: None,
        events: Vec::new(),
        issues: Vec::new(),
        dropped_event_count: 0,
    }
}

pub(super) fn build_snapshot(session: &WatchSession) -> WatchSessionReportRuntime {
    let completed = session.status == "completed";
    let session_elapsed_ms = session.elapsed_ms();
    let mut cues = session.cues.clone();
    let mut session_issues = session.issues.clone();
    let latest_indices = cues.iter().enumerate().fold(
        HashMap::<String, usize>::new(),
        |mut latest, (index, cue)| {
            latest
                .entry(cue.cue_id.clone())
                .and_modify(|latest_index| {
                    let latest_cue = &cues[*latest_index];
                    if (cue.revision, cue.sequence, index)
                        > (latest_cue.revision, latest_cue.sequence, *latest_index)
                    {
                        *latest_index = index;
                    }
                })
                .or_insert(index);
            latest
        },
    );
    // A streaming provider can publish and visibly render many cumulative
    // revisions, then emit one final source-only hypothesis immediately before
    // capture stops. That interrupted tail remains useful diagnostic detail,
    // but it must not replace the logical cue's latest complete visible
    // revision in latency/completeness summaries. If the logical cue has no
    // complete predecessor, omit the interrupted fragment from summary samples.
    let representative_indices = latest_indices
        .iter()
        .filter_map(|(cue_id, latest_index)| {
            let latest = &cues[*latest_index];
            if is_interrupted_session_tail(latest, completed, session_elapsed_ms) {
                return cues
                    .iter()
                    .enumerate()
                    .filter(|(index, cue)| {
                        cue.cue_id == *cue_id
                            && (cue.revision, cue.sequence, *index)
                                < (latest.revision, latest.sequence, *latest_index)
                            && cue_has_complete_visible_pipeline(cue)
                    })
                    .max_by_key(|(index, cue)| (cue.revision, cue.sequence, *index))
                    .map(|(index, _)| (cue_id.clone(), index));
            }
            Some((cue_id.clone(), *latest_index))
        })
        .collect::<HashMap<_, _>>();

    for (index, cue) in cues.iter_mut().enumerate() {
        let latest_index = latest_indices.get(&cue.cue_id).copied();
        let interrupted_tail = latest_index == Some(index)
            && is_interrupted_session_tail(cue, completed, session_elapsed_ms);
        cue.events.sort_by_key(|event| event.elapsed_ms);
        let superseded = !interrupted_tail
            && representative_indices.get(&cue.cue_id).copied() != Some(index);
        if superseded {
            cue.translation_state = Some(SubtitleTranslationStateRuntime::Superseded);
        }
        normalize_final_pipeline_timestamps(cue);
        cue.source_to_llm_first_ms = duration_between(cue.source_at_ms, cue.llm_first_at_ms);
        cue.source_to_render_ms = duration_between(cue.source_at_ms, cue.rendered_first_at_ms);
        cue.llm_first_to_publish_ms =
            duration_between(cue.llm_first_at_ms, cue.published_first_at_ms);
        cue.publish_to_render_ms =
            duration_between(cue.published_first_at_ms, cue.rendered_first_at_ms);
        cue.llm_first_to_render_ms =
            duration_between(cue.llm_first_at_ms, cue.rendered_first_at_ms);
        cue.llm_final_to_publish_ms =
            duration_between(cue.llm_final_at_ms, cue.published_final_at_ms);
        cue.published_final_to_render_ms =
            duration_between(cue.published_final_at_ms, cue.rendered_final_at_ms);
        cue.llm_final_to_render_ms =
            duration_between(cue.llm_final_at_ms, cue.rendered_final_at_ms);
        cue.audio_to_source_first_ms =
            duration_between(cue.audio_started_at_ms, cue.source_at_ms);
        cue.audio_to_llm_first_ms =
            duration_between(cue.audio_started_at_ms, cue.llm_first_at_ms);
        let translation_final =
            cue.translation_state == Some(SubtitleTranslationStateRuntime::Final);
        cue.audio_to_render_first_ms = translation_final
            .then(|| duration_between(cue.audio_started_at_ms, cue.rendered_first_at_ms))
            .flatten();
        cue.audio_to_render_final_ms = translation_final
            .then(|| duration_between(cue.audio_started_at_ms, cue.rendered_final_at_ms))
            .flatten();
        cue.comparison_status = comparison_status(cue, completed, superseded);
        attribute_dynamic_issues(cue, completed && !superseded, session_elapsed_ms);
        if cue.llm_text.is_empty()
            && cue
                .issues
                .iter()
                .any(|issue| issue.category == "model" && issue.severity == "error")
        {
            cue.comparison_status = "model-error".to_string();
        }
    }

    if session.dropped_cue_count > 0 || session.dropped_event_count > 0 {
        session_issues.push(WatchIssueRuntime {
            category: "data".to_string(),
            code: "events-truncated".to_string(),
            severity: "warning".to_string(),
            message: format!(
                "报告达到内存上限：丢弃 {} 个 cue、{} 条事件。",
                session.dropped_cue_count, session.dropped_event_count
            ),
            cue_id: None,
            elapsed_ms: None,
            occurrence_count: 1,
        });
    }

    let latest_cues = cues
        .iter()
        .enumerate()
        .filter_map(|(index, cue)| {
            representative_indices
                .get(&cue.cue_id)
                .is_some_and(|representative| index == *representative)
                .then_some(cue)
        })
        .collect::<Vec<_>>();
    if completed
        && latest_cues.is_empty()
        && !cues.iter().any(|cue| {
            cue.issues
                .iter()
                .any(|issue| issue.code == "session-ended-before-model-output")
        })
        && !session_issues
            .iter()
            .any(|issue| issue.code == "session-no-cues")
    {
        session_issues.push(WatchIssueRuntime {
            category: "output".to_string(),
            code: "session-no-cues".to_string(),
            severity: "error".to_string(),
            message: "本次看片未生成任何字幕 cue；请检查媒体播放、音频采集设备和语音模型连接。"
                .to_string(),
            cue_id: None,
            elapsed_ms: Some(session_elapsed_ms),
            occurrence_count: 1,
        });
    }
    let source_to_llm = latest_cues
        .iter()
        .filter_map(|cue| cue.source_to_llm_first_ms)
        .collect::<Vec<_>>();
    let source_to_render = latest_cues
        .iter()
        .filter_map(|cue| cue.source_to_render_ms)
        .collect::<Vec<_>>();
    let high_confidence_cues = latest_cues
        .iter()
        .copied()
        .filter(|cue| {
            cue.translation_state == Some(SubtitleTranslationStateRuntime::Final)
                && is_high_confidence_audio_origin(cue.audio_start_origin.as_deref())
        })
        .collect::<Vec<_>>();
    let audio_to_render_first = high_confidence_cues
        .iter()
        .filter_map(|cue| cue.audio_to_render_first_ms)
        .collect::<Vec<_>>();
    let audio_to_render_final = high_confidence_cues
        .iter()
        .filter_map(|cue| cue.audio_to_render_final_ms)
        .collect::<Vec<_>>();
    let llm_to_render = latest_cues
        .iter()
        .filter_map(|cue| cue.llm_first_to_render_ms)
        .collect::<Vec<_>>();
    let final_to_render = latest_cues
        .iter()
        .filter_map(|cue| cue.llm_final_to_render_ms)
        .collect::<Vec<_>>();
    let slowest_cue_id = latest_cues
        .iter()
        .filter_map(|cue| cue.source_to_render_ms.map(|latency| (latency, cue.cue_id.clone())))
        .max_by_key(|(latency, _)| *latency)
        .map(|(_, cue_id)| cue_id);
    let cue_issue_count = cues.iter().map(|cue| cue.issues.len()).sum::<usize>();
    let issue_occurrence_count = cues
        .iter()
        .flat_map(|cue| &cue.issues)
        .chain(&session_issues)
        .map(|issue| issue.occurrence_count)
        .sum::<u64>();
    let visible_render_cue_count = latest_cues
        .iter()
        .filter(|cue| cue.rendered_first_at_ms.is_some())
        .count();
    // `unrenderedCueCount` is shown as an overlay-rendering diagnostic. Do not
    // classify cues that never reached subtitle publication as renderer
    // failures: model/no-output and publish failures already have their own
    // comparison states and issue categories. Only a published translation
    // that lacks a visible receipt belongs in this counter.
    let unrendered_cue_count = latest_cues
        .iter()
        .filter(|cue| !cue.published_text.is_empty() && cue.rendered_first_at_ms.is_none())
        .count();
    let complete_cue_count = latest_cues
        .iter()
        .filter(|cue| {
            cue.llm_first_at_ms.is_some()
                && cue.published_first_at_ms.is_some()
                && cue.rendered_first_at_ms.is_some()
        })
        .count();
    let mut events = session.events.clone();
    events.sort_by_key(|event| event.elapsed_ms);

    WatchSessionReportRuntime {
        session_id: session.session_id.clone(),
        status: session.status.clone(),
        route_mode: session.route_mode.clone(),
        provider_id: session.provider_id.clone(),
        model: session.model.clone(),
        model_protocol_profile_identity: session.model_protocol_profile_identity.clone(),
        started_at: session.started_at.clone(),
        ended_at: session.ended_at.clone(),
        elapsed_ms: session_elapsed_ms,
        summary: WatchSessionReportSummaryRuntime {
            duration_ms: session_elapsed_ms,
            cue_count: latest_cues.len(),
            complete_cue_count,
            visible_render_cue_count,
            unrendered_cue_count,
            issue_count: cue_issue_count + session_issues.len(),
            issue_occurrence_count,
            average_source_to_llm_first_ms: average(&source_to_llm),
            p95_source_to_llm_first_ms: percentile_95(&source_to_llm),
            max_source_to_llm_first_ms: source_to_llm.iter().copied().max(),
            average_source_to_render_ms: average(&source_to_render),
            p95_source_to_render_ms: percentile_95(&source_to_render),
            max_source_to_render_ms: source_to_render.iter().copied().max(),
            average_audio_to_render_first_ms: average(&audio_to_render_first),
            p95_audio_to_render_first_ms: percentile_95(&audio_to_render_first),
            max_audio_to_render_first_ms: audio_to_render_first.iter().copied().max(),
            average_audio_to_render_final_ms: average(&audio_to_render_final),
            p95_audio_to_render_final_ms: percentile_95(&audio_to_render_final),
            max_audio_to_render_final_ms: audio_to_render_final.iter().copied().max(),
            average_llm_first_to_render_ms: average(&llm_to_render),
            p95_llm_first_to_render_ms: percentile_95(&llm_to_render),
            max_llm_first_to_render_ms: llm_to_render.iter().copied().max(),
            average_llm_final_to_render_ms: average(&final_to_render),
            p95_llm_final_to_render_ms: percentile_95(&final_to_render),
            max_llm_final_to_render_ms: final_to_render.iter().copied().max(),
            slowest_cue_id,
        },
        cues,
        events,
        issues: session_issues,
        dropped_cue_count: session.dropped_cue_count,
        dropped_event_count: session.dropped_event_count,
    }
}

fn is_high_confidence_audio_origin(origin: Option<&str>) -> bool {
    matches!(origin, Some("provider-offset" | "manual-audible" | "local-rms"))
}

fn duration_between(start: Option<u64>, end: Option<u64>) -> Option<u64> {
    match (start, end) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    }
}

fn normalize_final_pipeline_timestamps(cue: &mut WatchCueComparisonRuntime) {
    if cue.translation_state != Some(SubtitleTranslationStateRuntime::Final) {
        return;
    }

    let model = normalize_comparison_text(&cue.llm_text);
    let published = normalize_comparison_text(&cue.published_text);
    let rendered = normalize_comparison_text(&cue.rendered_text);
    if !model.is_empty() && model == published {
        if let Some(llm_final) = cue.llm_final_at_ms {
            cue.published_final_at_ms = Some(cue.published_final_at_ms.unwrap_or(llm_final).max(llm_final));
        }
    }
    if !published.is_empty() && published == rendered {
        // An equivalent final revision can inherit a committed visible receipt
        // from a superseded revision. The donor keeps the real render event and
        // its original timestamp; the selected final revision has no local
        // render event of its own. Anchor that revision's first-stage pipeline
        // at publication confirmation so its derived stage order remains
        // monotonic without rewriting the authoritative donor evidence.
        let inherited_render_receipt = cue.rendered_first_at_ms.is_some()
            && !cue.events.iter().any(|event| event.stage == "render");
        if inherited_render_receipt {
            if let Some(published_first) = cue.published_first_at_ms {
                cue.rendered_first_at_ms = Some(
                    cue.rendered_first_at_ms
                        .unwrap_or(published_first)
                        .max(published_first),
                );
            }
        }
        if let Some(published_final) = cue.published_final_at_ms {
            cue.rendered_final_at_ms = Some(cue.rendered_final_at_ms.unwrap_or(published_final).max(published_final));
        }
    }
}

fn comparison_status(
    cue: &WatchCueComparisonRuntime,
    completed: bool,
    superseded: bool,
) -> String {
    if superseded {
        return "superseded".to_string();
    }
    let has_model_error = cue
        .issues
        .iter()
        .any(|issue| issue.severity == "error");
    if has_model_error && cue.llm_text.is_empty() {
        return "model-error".to_string();
    }
    if cue.published_text.is_empty() {
        return if completed {
            "not-published".to_string()
        } else {
            "pending".to_string()
        };
    }
    if cue.rendered_first_at_ms.is_none() {
        return if completed {
            "not-rendered".to_string()
        } else {
            "pending".to_string()
        };
    }
    if cue.llm_text == cue.published_text && cue.published_text == cue.rendered_text {
        return "exact".to_string();
    }
    let normalized_model = normalize_comparison_text(&cue.llm_text);
    let normalized_published = normalize_comparison_text(&cue.published_text);
    let normalized_rendered = normalize_comparison_text(&cue.rendered_text);
    if normalized_model == normalized_published && normalized_published == normalized_rendered {
        "formatting-only".to_string()
    } else {
        "different".to_string()
    }
}

const INTERRUPTED_TAIL_GRACE_MS: u64 = 1_500;

fn cue_has_complete_visible_pipeline(cue: &WatchCueComparisonRuntime) -> bool {
    cue.llm_first_at_ms.is_some()
        && cue.published_first_at_ms.is_some()
        && cue.rendered_first_at_ms.is_some()
}

fn is_interrupted_session_tail(
    cue: &WatchCueComparisonRuntime,
    completed: bool,
    session_elapsed_ms: u64,
) -> bool {
    if !completed
        || cue.source_text.is_empty()
        || !cue.llm_text.is_empty()
        || cue.issues.iter().any(|issue| issue.severity == "error")
    {
        return false;
    }
    let source_finalized = cue
        .events
        .iter()
        .any(|event| event.stage == "source" && event.accepted && event.final_event);
    let last_source_update_ms = cue
        .events
        .iter()
        .filter(|event| event.stage == "source" && event.accepted)
        .map(|event| event.elapsed_ms)
        .max()
        .or(cue.source_at_ms);
    let tail_age_ms = last_source_update_ms
        .and_then(|elapsed_ms| session_elapsed_ms.checked_sub(elapsed_ms));
    !source_finalized || tail_age_ms.is_some_and(|age_ms| age_ms <= INTERRUPTED_TAIL_GRACE_MS)
}

fn attribute_dynamic_issues(
    cue: &mut WatchCueComparisonRuntime,
    completed: bool,
    session_elapsed_ms: u64,
) {
    let interrupted_session_tail =
        is_interrupted_session_tail(cue, completed, session_elapsed_ms);
    let mut push = |
        category: &str,
        code: &str,
        severity: &str,
        message: &str,
        elapsed_ms: Option<u64>,
    | {
        if !cue.issues.iter().any(|issue| issue.code == code) {
            cue.issues.push(WatchIssueRuntime {
                category: category.to_string(),
                code: code.to_string(),
                severity: severity.to_string(),
                message: message.to_string(),
                cue_id: Some(cue.cue_id.clone()),
                elapsed_ms,
                occurrence_count: 1,
            });
        }
    };

    if completed && !cue.source_text.is_empty() && cue.llm_text.is_empty() {
        let source_finalized = cue.events.iter().any(|event| {
            event.stage == "source" && event.accepted && event.final_event
        });
        let last_source_update_ms = cue
            .events
            .iter()
            .filter(|event| event.stage == "source" && event.accepted)
            .map(|event| event.elapsed_ms)
            .max()
            .or(cue.source_at_ms);
        if interrupted_session_tail {
            let message = if source_finalized {
                "会话在该尾段原文更新后立即结束，模型尚未来得及完成输出；这不是已确认的模型故障。"
            } else {
                "该尾段只有原文增量、没有收到原文终稿确认；会话结束时模型尚未输出，不能归因为已确认的模型故障。"
            };
            push(
                "session",
                "session-ended-before-model-output",
                "warning",
                message,
                last_source_update_ms,
            );
        } else {
            push(
                "model",
                "model-no-output",
                "error",
                "模型没有为该字幕输出可采用文本。",
                cue.source_at_ms,
            );
        }
    }
    if completed && !cue.llm_text.is_empty() && cue.published_text.is_empty() {
        push(
            "publish",
            "model-output-not-published",
            "error",
            "模型已输出可采用文本，但字幕状态没有发布该内容。",
            cue.llm_final_at_ms.or(cue.llm_first_at_ms),
        );
    }
    if completed && !cue.published_text.is_empty() && cue.rendered_first_at_ms.is_none() {
        push(
            "render",
            "publish-without-render",
            "warning",
            "字幕已发布，但悬浮窗没有可见渲染确认。",
            cue.published_final_at_ms.or(cue.published_first_at_ms),
        );
    }
    if cue.translation_state == Some(SubtitleTranslationStateRuntime::Error) {
        push(
            "publish",
            "translation-terminal-error",
            "error",
            "字幕翻译进入明确的错误终态。",
            cue.published_final_at_ms.or(cue.published_first_at_ms),
        );
    }
    if cue.comparison_status == "different" {
        push(
            "content",
            "content-different",
            "warning",
            "模型采用文本与悬浮窗实际文本内容不同。",
            cue.rendered_final_at_ms.or(cue.rendered_first_at_ms),
        );
    }
    let invalid_stage_order = [
        (cue.source_at_ms, cue.llm_first_at_ms),
        (cue.llm_first_at_ms, cue.published_first_at_ms),
        (cue.published_first_at_ms, cue.rendered_first_at_ms),
        (cue.llm_final_at_ms, cue.published_final_at_ms),
        (cue.published_final_at_ms, cue.rendered_final_at_ms),
    ]
    .into_iter()
    .any(|(start, end)| matches!((start, end), (Some(start), Some(end)) if end < start));
    if invalid_stage_order {
        push(
            "timing",
            "invalid-stage-order",
            "warning",
            "阶段时间戳顺序异常，相关延迟未计入汇总。",
            cue.rendered_final_at_ms
                .or(cue.rendered_first_at_ms)
                .or(cue.published_final_at_ms),
        );
    }
    if cue.dropped_event_count > 0 {
        push(
            "data",
            "cue-events-truncated",
            "warning",
            "该 cue 的时间线事件达到上限，部分增量已丢弃。",
            None,
        );
    }
}

pub(crate) fn normalize_comparison_text(text: &str) -> String {
    text.chars().filter(|character| !character.is_whitespace()).collect()
}

pub(super) fn correlation_text(text: &str) -> String {
    text.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn average(values: &[u64]) -> Option<u64> {
    (!values.is_empty()).then(|| {
        let total = values.iter().map(|value| *value as u128).sum::<u128>();
        (total / values.len() as u128) as u64
    })
}

fn percentile_95(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = ((sorted.len() as f64 * 0.95).ceil() as usize).saturating_sub(1);
    sorted.get(rank).copied()
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub(super) fn sanitize_error(error: &str) -> String {
    let mut safe = truncate_chars(error, MAX_DETAIL_CHARS);
    for marker in [
        "Bearer ",
        "bearer ",
        "api_key=",
        "api_key:",
        "api_key\":",
        "apiKey=",
        "apiKey:",
        "apiKey\":",
        "api-key=",
        "x-api-key=",
        "x-api-key:",
        "access_token=",
        "access_token\":",
        "key=",
        "token=",
        "token:",
        "token\":",
        "secret=",
        "secret:",
        "secret\":",
        "secret_id=",
        "secret_key=",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = safe[search_from..].find(marker) {
            let start = search_from + relative_start;
            let marker_end = start + marker.len();
            let value_start = safe[marker_end..]
                .char_indices()
                .find_map(|(offset, character)| {
                    (!character.is_whitespace() && !matches!(character, '"' | '\''))
                        .then_some(marker_end + offset)
                })
                .unwrap_or(safe.len());
            if safe[value_start..].starts_with("[REDACTED]") {
                search_from = value_start + "[REDACTED]".len();
                continue;
            }
            let value_end = safe[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, '&' | ',' | '"' | '\'')
                })
                .map(|offset| value_start + offset)
                .unwrap_or(safe.len());
            safe.replace_range(value_start..value_end, "[REDACTED]");
            search_from = value_start + "[REDACTED]".len();
        }
    }
    safe
}
