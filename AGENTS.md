# Global encoding precautions

- When reading, editing, or generating files that contain Chinese text on Windows, treat encoding as a first-class concern.
- Prefer UTF-8 for new files and when rewriting files. Do not assume legacy Windows Chinese files are UTF-8; they may be GBK/ANSI.
- Before modifying a file with Chinese text that appears garbled, check whether the issue is terminal display encoding, file encoding mismatch, or already-corrupted content.
- Avoid rewriting non-UTF-8 files after reading them with the wrong encoding. If conversion is needed, preserve the original content and convert deliberately.
- For PowerShell commands that write Chinese text, specify UTF-8 explicitly where applicable, for example `Set-Content -Encoding utf8` or `Out-File -Encoding utf8`.
- If terminal output shows garbled Chinese, consider setting UTF-8 output for the session before diagnosing file corruption: `chcp 65001`, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`, and `$OutputEncoding = [System.Text.Encoding]::UTF8`.
- 禁止使用格式化命令批量修改文件
