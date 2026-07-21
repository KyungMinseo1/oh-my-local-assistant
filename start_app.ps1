# Start the application in a new PowerShell window

Start-Process pwsh -ArgumentList '-NoExit', '-Command', @"
cd '$PSScriptRoot'
npm start
"@