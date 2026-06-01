import os
import re
import json
import sys

# Set UTF-8 encoding for standard output
sys.stdout.reconfigure(encoding='utf-8')

LOG_PATH = r"<repository-root>\artifacts\diagnostics\logs\app.log"
OUTPUT_PATH = r"<repository-root>\artifacts\diagnostics\logs\app_compressed.log"

LOG_PATTERN = re.compile(r'^([\d-]+\s[\d:.]+)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*?)$')

def load_and_preprocess_logs(path):
    """
    Reads the log file and groups multiline logs (continuation lines)
    together with their main parent line.
    """
    if not os.path.exists(path):
        print(f"Error: Log file not found at {path}")
        sys.exit(1)
        
    raw_logs = []
    current_log = None
    
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        for line_num, line in enumerate(f, 1):
            line_str = line.rstrip('\n')
            match = LOG_PATTERN.match(line_str)
            
            if match:
                if current_log:
                    raw_logs.append(current_log)
                ts, level, comp, content = match.groups()
                current_log = {
                    'start_line': line_num,
                    'timestamp': ts,
                    'level': level,
                    'component': comp,
                    'content': content,
                    'continuations': []
                }
            else:
                if current_log:
                    current_log['continuations'].append(line_str)
                else:
                    # Non-standard log lines at the very beginning of the file
                    raw_logs.append({
                        'start_line': line_num,
                        'timestamp': '',
                        'level': 'NORMAL',
                        'component': 'system',
                        'content': line_str,
                        'continuations': []
                    })
                    
    if current_log:
        raw_logs.append(current_log)
        
    return raw_logs

def is_idle_loop(log):
    """
    Checks if a log is an idle loop heartbeat.
    """
    if log['component'] != 'subtitle-translate' or log['level'] != 'DEBUG':
        return False
    
    # Matches: [LOOP#1] uncommitted=0 queued=0 forced=0 repl=0 final=0 in_flight=0 splitter(committed=0B buffer=0B pending=0) cues=[]
    content = log['content']
    if '[LOOP#' in content and 'uncommitted=0 queued=0 forced=0 repl=0 final=0 in_flight=0' in content and 'cues=[]' in content:
        return True
    return False

def extract_loop_num(content):
    match = re.search(r'\[LOOP#(\d+)\]', content)
    return int(match.group(1)) if match else None

def is_socket_trace(log):
    return log['component'] == 'omni' and log['level'] == 'TRACE' and '[SOCKET_TRACE] Read timeout/WouldBlock' in log['content']

def is_audio_chunk(log):
    return log['component'] == 'omni' and log['level'] == 'DEBUG' and '[AUDIO] 已发送' in log['content']

def extract_audio_chunk_info(content):
    # Example: [AUDIO] 已发送 100 个音频块 (768000 字节)
    match = re.search(r'已发送\s+(\d+)\s+个音频块\s+\((\d+)\s+字节\)', content)
    if match:
        return int(match.group(1)), int(match.group(2))
    return None

def is_transcription_delta(log):
    """
    Checks if the log line represents an incremental transcription update (delta).
    """
    content = log['content']
    if 'transcription.delta' in content or 'input_audio_transcription.delta' in content:
        return True
    return False

def parse_transcription_delta(log):
    """
    Extracts cue_id and text/stash from transcription delta logs.
    """
    content = log['content']
    # Check for [EVENT] transcription.delta → cue_id=... text="..." stash="..." pending="..."
    if 'transcription.delta →' in content:
        cue_match = re.search(r'cue_id=(\S+)', content)
        stash_match = re.search(r'stash="([^"]*)"', content)
        pending_match = re.search(r'pending="([^"]*)"', content)
        
        cue_id = cue_match.group(1) if cue_match else 'unknown'
        text = pending_match.group(1) if pending_match else (stash_match.group(1) if stash_match else '')
        return cue_id, text
    
    # Check for JSON in model-trace: ws.recv.conversation.item.input_audio_transcription.delta
    if 'ws.recv.conversation.item.input_audio_transcription.delta' in content:
        json_part = content.split(' | ', 1)
        if len(json_part) == 2:
            try:
                # payload might end with elapsed ms like "  (3569ms)"
                clean_json = re.sub(r'\s+\(\d+ms\)$', '', json_part[1])
                data = json.loads(clean_json)
                payload = data.get('payload', {})
                cue_id = data.get('cueId') or 'unknown'
                text = payload.get('stash') or payload.get('text') or ''
                return cue_id, text
            except Exception:
                pass
    return None, None

def simplify_model_trace_json(log):
    """
    Simplifies verbose JSON payloads in model-trace component to make them extremely readable.
    """
    if log['component'] != 'model-trace':
        return log['content']
        
    parts = log['content'].split(' | ', 1)
    if len(parts) != 2:
        return log['content']
        
    prefix, json_str = parts
    
    # Extract trailing time like "  (117ms)"
    time_match = re.search(r'\s+\(\d+ms\)$', json_str)
    time_suffix = time_match.group(0) if time_match else ''
    
    clean_json_str = re.sub(r'\s+\(\d+ms\)$', '', json_str)
    
    try:
        data = json.loads(clean_json_str)
        event = data.get('event', 'unknown')
        model = data.get('model', '')
        payload = data.get('payload', {})
        
        # Build a highly compact representation of the JSON based on the event type
        summary = f"{prefix} | EVENT={event}"
        if model:
            summary += f" model={model}"
            
        if event == 'input.connect':
            summary += f" | kind={payload.get('kind')} baseUrl={payload.get('baseUrl')} subtitleTranslateActive={payload.get('subtitleTranslateActive')}"
        elif event == 'ws.send.session.update':
            session = payload.get('session', {})
            summary += f" | modalities={session.get('modalities')} type={session.get('turn_detection', {}).get('type')}"
        elif event == 'ws.recv.session.created':
            session = payload.get('session', {})
            summary += f" | sessionId={session.get('id')} voice={session.get('voice')}"
        elif event == 'ws.recv.input_audio_buffer.speech_started':
            summary += f" | speech_started item_id={payload.get('item_id')}"
        elif event == 'provider.execute_smoke input.request':
            summary += f" | requestText=\"{payload.get('sourceText', '')[:60]}...\" targetLanguage={payload.get('targetLanguage')}"
        elif event == 'http.request.provider':
            summary += f" | kind={payload.get('kind')} transport={payload.get('transport')} timeoutMs={payload.get('timeoutMs')}"
        elif event == 'http.response.provider.error':
            error = payload.get('error', {})
            summary += f" | ❌ FAILED after {payload.get('durationMs')}ms: code={error.get('code')} message={error.get('message')}"
        elif event == 'end_call':
            summary += f" | status={payload.get('status')} elapsed={payload.get('elapsedMs')}ms"
            if payload.get('error'):
                summary += f" error=\"{payload.get('error')}\""
        else:
            # General fallback for other events
            items = []
            for k, v in payload.items():
                if isinstance(v, (str, int, float, bool)) and k not in ('type', 'event_id', 'item_id', 'content_index'):
                    items.append(f"{k}={v}")
            if items:
                summary += " | " + " ".join(items[:5])
                
        summary += time_suffix
        return summary
    except Exception:
        return log['content']

def simplify_llm_call(log):
    """
    Simplifies the LLM_CALL log and strips the multiline prompt continuation.
    """
    content = log['content']
    cue_match = re.search(r'cue_id=(\S+)', content)
    sent_len_match = re.search(r'sentence_len=(\d+)', content)
    prompt_len_match = re.search(r'prompt_len=(\d+)', content)
    
    cue_id = cue_match.group(1) if cue_match else 'unknown'
    sent_len = sent_len_match.group(1) if sent_len_match else '0'
    prompt_len = prompt_len_match.group(1) if prompt_len_match else '0'
    
    # Try to extract the source prompt text from the multiline continuations
    prompt_text = ""
    for line in log['continuations']:
        if line.startswith('prompt="') or line.startswith('"') or line.startswith('Context:') or line.startswith('Translate this'):
            prompt_text += " " + line.strip(' "')
            
    prompt_text = prompt_text.strip()
    if len(prompt_text) > 80:
        prompt_text = prompt_text[:80] + "..."
        
    return f"- - [LLM_CALL] cue_id={cue_id} sentence_len={sent_len} prompt_len={prompt_len} | text: \"{prompt_text}\""

def compress_logs(raw_logs):
    """
    Main compression engine applying stateful aggregation.
    """
    compressed_logs = []
    
    i = 0
    total_raw = len(raw_logs)
    
    while i < total_raw:
        log = raw_logs[i]
        
        # 1. Compress idle loops
        if is_idle_loop(log):
            start_idx = i
            start_loop = extract_loop_num(log['content'])
            last_ts = log['timestamp']
            
            while i + 1 < total_raw and is_idle_loop(raw_logs[i + 1]):
                i += 1
                last_ts = raw_logs[i]['timestamp']
                
            end_loop = extract_loop_num(raw_logs[i]['content'])
            count = i - start_idx + 1
            
            if count > 1:
                compressed_logs.append({
                    'timestamp': f"{log['timestamp']} ~ {last_ts}",
                    'level': 'DEBUG',
                    'component': 'subtitle-translate',
                    'content': f"- - [LOOP#{start_loop} to #{end_loop}] (IDLE HEARTBEAT x{count} COLLAPSED)"
                })
            else:
                compressed_logs.append({
                    'timestamp': log['timestamp'],
                    'level': log['level'],
                    'component': log['component'],
                    'content': log['content']
                })
            i += 1
            continue
            
        # 2. Compress socket trace connection timeouts
        if is_socket_trace(log):
            start_idx = i
            last_ts = log['timestamp']
            
            while i + 1 < total_raw and is_socket_trace(raw_logs[i + 1]):
                i += 1
                last_ts = raw_logs[i]['timestamp']
                
            count = i - start_idx + 1
            
            if count > 1:
                compressed_logs.append({
                    'timestamp': f"{log['timestamp']} ~ {last_ts}",
                    'level': 'TRACE',
                    'component': 'omni',
                    'content': f"- - [SOCKET_TRACE] Read timeout/WouldBlock (expected while waiting for events) (x{count} COLLAPSED)"
                })
            else:
                compressed_logs.append({
                    'timestamp': log['timestamp'],
                    'level': log['level'],
                    'component': log['component'],
                    'content': log['content']
                })
            i += 1
            continue
            
        # 3. Compress audio chunk logs
        if is_audio_chunk(log):
            start_idx = i
            last_ts = log['timestamp']
            total_chunks = 0
            total_bytes = 0
            
            info = extract_audio_chunk_info(log['content'])
            if info:
                total_chunks += info[0]
                total_bytes += info[1]
                
            while i + 1 < total_raw and is_audio_chunk(raw_logs[i + 1]):
                i += 1
                last_ts = raw_logs[i]['timestamp']
                info = extract_audio_chunk_info(raw_logs[i]['content'])
                if info:
                    total_chunks += info[0]
                    total_bytes += info[1]
                    
            count = i - start_idx + 1
            
            if count > 1:
                compressed_logs.append({
                    'timestamp': f"{log['timestamp']} ~ {last_ts}",
                    'level': 'DEBUG',
                    'component': 'omni',
                    'content': f"- - [AUDIO] 已发送 {count} 批音频块 (共 {total_chunks} 个音频块, {total_bytes / 1024 / 1024:.2f} MB)"
                })
            else:
                compressed_logs.append({
                    'timestamp': log['timestamp'],
                    'level': log['level'],
                    'component': log['component'],
                    'content': log['content']
                })
            i += 1
            continue
            
        # 4. Compress incremental transcription deltas
        if is_transcription_delta(log):
            start_idx = i
            last_ts = log['timestamp']
            cue_id, last_text = parse_transcription_delta(log)
            delta_count = 1
            
            while i + 1 < total_raw and is_transcription_delta(raw_logs[i + 1]):
                i += 1
                last_ts = raw_logs[i]['timestamp']
                next_cue, next_text = parse_transcription_delta(raw_logs[i])
                if next_cue and next_cue == cue_id:
                    if next_text:
                        last_text = next_text
                delta_count += 1
                
            if delta_count > 1:
                compressed_logs.append({
                    'timestamp': f"{log['timestamp']} ~ {last_ts}",
                    'level': 'DEBUG',
                    'component': 'omni',
                    'content': f"- - [TRANSCRIPTION_STREAMING] cue_id={cue_id} | Final text: \"{last_text}\" ({delta_count} streaming delta messages collapsed)"
                })
            else:
                # If only 1 delta, simplify and append
                simplified_text = last_text or log['content']
                compressed_logs.append({
                    'timestamp': log['timestamp'],
                    'level': log['level'],
                    'component': log['component'],
                    'content': f"- - [EVENT] transcription.delta → cue_id={cue_id} text=\"{simplified_text}\""
                })
            i += 1
            continue
            
        # 5. Simplify LLM call prompts
        if '[LLM_CALL]' in log['content']:
            simplified_content = simplify_llm_call(log)
            compressed_logs.append({
                'timestamp': log['timestamp'],
                'level': log['level'],
                'component': log['component'],
                'content': simplified_content
            })
            i += 1
            continue
            
        # 6. Simplify model-trace JSON logs
        if log['component'] == 'model-trace':
            simplified_content = simplify_model_trace_json(log)
            compressed_logs.append({
                'timestamp': log['timestamp'],
                'level': log['level'],
                'component': log['component'],
                'content': simplified_content
            })
            i += 1
            continue
            
        # Default: preserve line (simplifying its multiline continuation if any, or keeping them formatted)
        content = log['content']
        if log['level'] in ('ERROR', 'WARNING'):
            # Highlight error/warning message
            tag = "🔴 [ERROR]" if log['level'] == 'ERROR' else "⚠️ [WARNING]"
            content = f"{tag} {content}"
            
        compressed_logs.append({
            'timestamp': log['timestamp'],
            'level': log['level'],
            'component': log['component'],
            'content': content,
            'continuations': log['continuations']
        })
        i += 1
        
    return compressed_logs

def generate_compressed_log_file(raw_logs, compressed_logs, out_path):
    """
    Writes the compressed logs to the output path, adding a prominent diagnostics report at the top.
    """
    total_lines_original = sum(1 + len(l['continuations']) for l in raw_logs)
    
    # Calculate some diagnostics statistics
    errors = []
    warnings = []
    
    for l in raw_logs:
        if l['level'] == 'ERROR':
            errors.append(l)
        elif l['level'] == 'WARNING':
            warnings.append(l)
            
    # Count component distribution
    comp_counts = {}
    for l in raw_logs:
        c = l['component']
        comp_counts[c] = comp_counts.get(c, 0) + 1
        
    # Analyze LLM call failures
    total_llm_calls = 0
    failed_llm_calls = 0
    for l in raw_logs:
        if 'provider.execute_smoke end_call' in l['content']:
            total_llm_calls += 1
            parts = l['content'].split(' | ', 1)
            if len(parts) == 2:
                try:
                    clean_json = re.sub(r'\s+\(\d+ms\)$', '', parts[1])
                    data = json.loads(clean_json)
                    status = data.get('payload', {}).get('status')
                    if status == 'failed':
                        failed_llm_calls += 1
                except Exception:
                    if '"status":"failed"' in l['content']:
                        failed_llm_calls += 1

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write("================================================================================\n")
        f.write("                       OMNI-TRANSLATE DIAGNOSTICS REPORT                        \n")
        f.write("================================================================================\n\n")
        
        f.write("--- LOG COMPRESSION SUMMARY ---\n")
        f.write(f"Original Log Size    : {os.path.getsize(LOG_PATH) / 1024:.2f} KB\n")
        f.write(f"Original Log Lines   : {total_lines_original}\n")
        f.write(f"Compressed Log Lines : {len(compressed_logs)}\n")
        f.write(f"Compression Ratio    : {(1 - len(compressed_logs)/total_lines_original)*100:.1f}%\n\n")
        
        f.write("--- RUNTIME STATISTICS ---\n")
        if raw_logs:
            f.write(f"Start Time           : {raw_logs[0]['timestamp']}\n")
            f.write(f"End Time             : {raw_logs[-1]['timestamp']}\n")
        f.write("Component Activity Counts:\n")
        for comp, count in sorted(comp_counts.items(), key=lambda x: x[1], reverse=True):
            f.write(f"  - [{comp}]: {count} messages\n")
        f.write(f"Total Subtitle Translation LLM Requests: {total_llm_calls}\n")
        f.write(f"Failed / Timeout LLM Requests          : {failed_llm_calls} ({failed_llm_calls/max(1, total_llm_calls)*100:.1f}% failure rate)\n\n")
        
        f.write("================================================================================\n")
        f.write("                      CRITICAL WARNINGS & ERRORS SUMMARY                       \n")
        f.write("================================================================================\n")
        if not errors and not warnings:
            f.write("No errors or warnings found! Clean execution.\n")
        else:
            if warnings:
                f.write("\n⚠️  WARNING EVENTS:\n")
                for idx, w in enumerate(warnings, 1):
                    # Clean the encoding error text from the raw log message
                    clean_text = w['content'].replace('ʵ timeoutMsȱĻģʽ', '可适当提高 timeoutMs，或优先保留字幕优先模式。')
                    f.write(f"  [{idx}] Line {w['start_line']}: {w['timestamp']} [{w['component']}] {clean_text}\n")
            if errors:
                f.write("\n🔴  ERROR EVENTS:\n")
                for idx, e in enumerate(errors, 1):
                    clean_text = e['content'].replace('ʵ timeoutMsȱĻģʽ', '可适当提高 timeoutMs，或优先保留字幕优先模式。')
                    f.write(f"  [{idx}] Line {e['start_line']}: {e['timestamp']} [{e['component']}] {clean_text}\n")
                    
        f.write("\n================================================================================\n")
        f.write("                             COMPRESSED LOG TRACE                               \n")
        f.write("================================================================================\n\n")
        
        for c_log in compressed_logs:
            ts_str = f"{c_log['timestamp']} " if c_log['timestamp'] else ""
            level_str = f"[{c_log['level']}] " if c_log['level'] else ""
            comp_str = f"[{c_log['component']}] " if c_log['component'] else ""
            
            # Replace the broken unicode character block in Chinese logs for output readability
            clean_content = c_log['content']
            clean_content = clean_content.replace('ʵ timeoutMsȱĻģʽ', '可适当提高 timeoutMs，或优先保留字幕优先模式。')
            clean_content = clean_content.replace('ʱ: error sending request for url', '超时: error sending request for url')
            
            f.write(f"{ts_str}{level_str}{comp_str}{clean_content}\n")
            
            # Print continuations if any (only for non-simplified custom elements)
            if 'continuations' in c_log:
                for line in c_log['continuations']:
                    clean_line = line.replace('ʵ timeoutMsȱĻģʽ', '可适当提高 timeoutMs，或优先保留字幕优先模式。')
                    f.write(f"  {clean_line}\n")

if __name__ == '__main__':
    print("Loading log file...")
    raw_logs = load_and_preprocess_logs(LOG_PATH)
    print(f"Loaded {len(raw_logs)} logical log items.")
    
    print("Compressing log patterns...")
    compressed = compress_logs(raw_logs)
    print(f"Compressed down to {len(compressed)} items.")
    
    print("Writing compressed output and diagnostic summary...")
    generate_compressed_log_file(raw_logs, compressed, OUTPUT_PATH)
    
    print(f"Success! Output generated at: {OUTPUT_PATH}")
    original_lines = sum(1 + len(l['continuations']) for l in raw_logs)
    compressed_lines = len(compressed)
    print(f"Original lines   : {original_lines}")
    print(f"Compressed lines : {compressed_lines}")
    print(f"Compression ratio: {(1 - compressed_lines / original_lines) * 100:.2f}%")
