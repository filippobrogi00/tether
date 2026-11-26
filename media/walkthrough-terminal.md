## A terminal on the server

**Tether: Remote Terminal** opens a terminal that runs on the server, already inside your project folder, on its own SSH connection. When tmux or screen is available, the session stays alive and this panel reattaches if the connection drops. Disconnect or close asks **Terminate** or **Keep alive**.

Files that a command creates or changes on the server are copied back shortly after the command runs.

Need to move files with the mouse? Run **Tether: Toggle Remote View** for a second Explorer root and drag between local and remote. Run it again to close Remote View and restore your original folder workspace.

Need to see a web app that runs on the server? Click the status-bar item and choose **Forward a Port…** to make it available at `http://localhost:<port>`.
