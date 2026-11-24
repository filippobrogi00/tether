## Connect

When a folder is already open, Tether asks what to sync before it connects:

1. **Choose what to sync.** Top-level files and folders are listed with checkboxes. Build output, caches, and `.git` start unchecked. Uncheck anything else that should stay on this computer, then press Enter.
2. **Choose a server.** Hosts from your SSH config are listed automatically. Otherwise type `user@hostname`.
3. **Choose a folder on the server.** Click through the folders; no need to remember a path.

With an empty window, Tether starts from the server instead: pick a host, pick a remote folder, then a place on this computer for the working copy.

**Connect Folder…** pairs the two sides and starts continuous two-way sync. Because the files are local, every extension you have (language servers, linters, formatters, Git, AI assistants) works exactly as it does for any local project, and nothing is installed on the server.
