## Connect

When a folder is already open and not yet paired, Tether asks what to sync before it connects:

1. **Choose what to sync.** Top-level files and folders are listed with checkboxes. Build output, caches, and `.git` start unchecked. Uncheck anything else that should stay on this computer, then press Enter.
2. **One server or several.** Hosts from your SSH config are listed automatically. You can pair the same local folder with more than one remote (your computer is the hub).
3. **Choose a folder on each server.** Click through the folders; no need to remember a path.

The next time you run **Connect Folder…**, Tether reconnects to that saved pairing. Use **Pair with Different Servers…** to choose new hosts or folders, **Add Remote Server…** to pair another server while connected, or **Change Folder…** to remount one server onto a different remote path.

With an empty window, Tether starts from the server instead: pick a host, pick a remote folder, then a place on this computer for the working copy.

**Connect Folder…** starts continuous two-way sync. Because the files are local, every extension you have works as usual, and nothing is installed on the server.
