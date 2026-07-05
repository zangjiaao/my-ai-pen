---
name: file-upload
description: Use when the application accepts multipart files, avatars, documents, import packages, media, or returns an uploaded file path.
---

# File Upload

Start with a benign marker file before testing executable content.

1. Use `browser` or `traffic` to capture the real multipart form and session.
2. Look up `poc(action="get", vuln_class="file-upload")`.
3. Upload a unique harmless marker file and verify whether it is retrievable.
4. If policy allows, test extension/MIME bypass and execution only after proving the landing path.
5. Confirm with upload request evidence plus retrieval or execution evidence.
6. Mark coverage for `(endpoint, uploaded, file-upload)`.

Do not leave web shells or persistent executable payloads behind.
