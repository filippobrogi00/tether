## Connect

When a folder is already open, Tether asks what to sync before it connects:

1. **Choose what to sync.** Top-level files and folders are listed with checkboxes. Build output, caches, and `.git` start unchecked. Uncheck anything else that should stay on this computer, then press Enter.
2. **One server or several.** Hosts from your SSH config are listed automatically. You can pair the same local folder with more than one remote (your computer is the hub).
3. **Choose a folder on each server.** Click through the folders; no need to remember a path.

Already connected? **Tether: Add Remote Server…** (status bar, or the Command Palette) pairs another server with this folder. If both sides already have files, Tether merges them the same way as the first connect.

With an empty window, Tether starts from the server instead: pick a host, pick a remote folder, then a place on this computer for the working copy.

**Connect Folder…** starts continuous two-way sync. Because the files are local, every extension you have works as usual, and nothing is installed on the server.
