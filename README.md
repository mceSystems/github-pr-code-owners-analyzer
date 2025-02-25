# GitHub PR Code Owners Analyzer

A Chrome extension that analyzes GitHub pull requests to identify code owners and help ensure proper reviews.

## Features

- Automatically detects and displays code owners for files in a GitHub pull request
- Shows owners who can individually approve all changed files
- Displays up to 3 optimal combinations of reviewers who together can approve all files
- Highlights which owners who have already approved the PR
- Persists across page refreshes but respects manual dismissal
- Toggle extension on/off with a single click

## How It Works

The extension:

1. Parses the repository's CODEOWNERS file to understand ownership rules
2. Analyzes the files changed in the current PR
3. Identifies owners who can individually approve all changes
4. Finds optimal combinations of reviewers who together can cover all files
5. Shows approval status for each owner based on PR reviews

## Installation

1. Clone this repository or download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the directory containing the extension files
5. The extension icon should appear in your Chrome toolbar

## Usage

1. Navigate to any GitHub pull request's "Files changed" tab
2. The extension will automatically display a panel showing:
   - Full Coverage Owners: Individuals who can approve all changed files
   - Combined Coverage Sets: Optimal combinations of reviewers who together can approve all files
3. Green checkmarks indicate owners who have already approved the PR
4. Click section headers to collapse/expand sections
5. Click the X to dismiss the panel for the current session

## Development

### Building the Extension

1. Clone the repository
2. Make your changes
3. Load the unpacked extension in Chrome's developer mode

### Files

- `content.js`: Main content script that analyzes PRs and displays results
- `background.js`: Handles extension state and icon updates
- `styles.css`: Styling for the UI panel
- `manifest.json`: Extension configuration

## License

[MIT License](LICENSE) 