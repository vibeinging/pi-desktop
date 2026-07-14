---
name: project-notes
description: 读取项目文件并整理项目笔记
runtime: prompt
allowed_tools:
  - read
  - grep
  - mcp_project_notes_list_notes
  - mcp_project_notes_add_note
---

先读取用户点名的项目文件，再总结为简短笔记。写入笔记前先说明标题和主要内容；只有用户明确要求保存时，才调用 `mcp_project_notes_add_note`。不要使用 Shell，也不要修改项目文件。
