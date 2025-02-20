# GitHub PR Code Owners Analyzer

A Chrome extension that helps analyze code ownership in GitHub pull requests by showing which users can provide full coverage approval based on the repository's CODEOWNERS file.

## Features

- 🔍 Automatically detects and parses CODEOWNERS files
- 👥 Shows users who can individually approve all changed files
- 🤝 Identifies combinations of users who together can approve all changes
- ✅ Highlights which owners have already approved the PR
- 🎯 Updates in real-time as files change in the PR
- 🖱️ Draggable UI panel with collapsible sections
- 🌙 Supports GitHub dark mode

## Installation

1. Clone this repository or download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the directory containing the extension files
5. The extension icon should appear in your Chrome toolbar

## Usage

1. Navigate to any GitHub pull request's "Files changed" tab
2. The Code Owners Analysis panel will appear on the right side
3. The panel shows two main sections:
   - **Full Coverage Owners**: Users who can individually approve all changed files
   - **Combined Coverage Sets**: Groups of users who together can approve all files
4. Green checkmarks (✓) indicate owners who have already approved the PR
5. Hover over the info icons (ℹ️) for more details about each section
6. You can:
   - Drag the panel to reposition it
   - Double-click section titles or use arrows to collapse/expand sections
   - Double-click the top bar or use the arrow to collapse the entire panel
   - Click the X to close the panel (the extension remains active)

## Controls

- 🔄 Click the extension icon in the toolbar to enable/disable the extension
- 👆 Double-click section headers to collapse/expand sections
- ✨ Drag the panel by its header to reposition
- ❌ Click the X to close the panel (extension remains active)

## Development

The extension consists of these main files:
- `manifest.json`: Extension configuration
- `content.js`: Main logic for analyzing code ownership and UI
- `background.js`: Handles extension state and icon updates
- `styles.css`: UI styling

## Notes

- The extension currently works only on the "Files changed" tab of pull requests
- CODEOWNERS file is searched in the default location (.github/CODEOWNERS)
- The extension respects GitHub's dark/light theme settings

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT License](LICENSE) 