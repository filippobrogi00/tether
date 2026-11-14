## A terminal on the server

**Tether: Remote Terminal** opens a terminal that runs on the server, already inside your project folder. When tmux or screen is available, the session is kept alive across disconnects — you will be asked **Terminate** or **Keep alive** when you disconnect or close the editor.

Files that a command creates or changes on the server are copied back shortly after the command runs.

Need to move files with the mouse? Run **Tether: Remote View** for a second Explorer root and drag between local and remote.

Need to see a web app that runs on the server? Click the status-bar item and choose **Forward a Port…** to make it available at `http://localhost:<port>`.
