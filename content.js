class CodeOwnersAnalyzer {
    constructor() {
        console.log('CodeOwnersAnalyzer constructor called');
        this.codeownersMap = new Map();
        this.changedFiles = new Set();
        this.approvedReviewers = new Set();
        this._fileOwnersCache = {};
        this._parsedPatterns = null;
        this.MAX_COMBINATION_SIZE = 5; // limit the number of owners in a combination
        this.MAX_COMBINATIONS_TO_SHOW = 15; // limit the total number of combinations shown in UI
        
        // Add debug mode flag - set to false in production
        this.DEBUG_MODE = true;
        
        // Track files with and without owners
        this.filesWithOwners = new Set();
        this.filesWithoutOwners = new Set();
    }

    // Logger function to control verbosity
    log(message, level = 'info', ...args) {
        if (!this.DEBUG_MODE && level === 'debug') return;
        
        if (level === 'error') {
            console.error(message, ...args);
        } else if (level === 'warn') {
            console.warn(message, ...args);
        } else if (this.DEBUG_MODE || level === 'info') {
            console.log(message, ...args);
        }
    }

    async initialize() {
        console.log('Initializing CodeOwnersAnalyzer...');
        
        // Check if panel was explicitly closed this session
        if (sessionStorage.getItem('codeOwnersPanelClosed') === 'true') {
            console.log('Panel was explicitly closed this session, not showing UI');
            return;
        }
        
        try {
            // Cache DOM elements that are used multiple times
            const headerMeta = document.querySelector('.gh-header-meta');
            const headerTitle = document.querySelector('.gh-header-title');
            const tabContent = document.querySelector('.pull-request-tab-content');
            
            // Wait for the PR header and state to be loaded
            await Promise.race([
                this.waitForElement('.gh-header-meta'),
                this.waitForElement('.gh-header-title'),
                this.waitForElement('.pull-request-tab-content'),
                this.waitForElement('.js-pull-refresh-on-pjax')
            ]);
            
            // Wait specifically for the PR state to be available
            await this.waitForPRState();
            
            console.log('PR UI elements loaded, checking state...');

            // Get PR author early
            this.prAuthor = await this.getPRAuthor();
            console.log('PR author:', this.prAuthor);

            // Check if PR is merged first
            const mergeStatus = document.querySelector('.State--merged');
            if (mergeStatus) {
                console.log('PR is merged, not showing UI');
                return;
            }

            // Show UI for both draft and open PRs
            const prStateLabel = document.querySelector('.State');
            const isDraft = prStateLabel && prStateLabel.textContent.toLowerCase().includes('draft');
            const isOpen = document.querySelector('.State--open') || (prStateLabel && prStateLabel.textContent.toLowerCase().includes('open'));
            
            console.log('Draft PR detection details:', {
                'State label text': prStateLabel?.textContent,
                isDraft
            });

            // Log all state-related elements for debugging
            console.log('All state elements:', {
                'gh-header-meta': headerMeta?.outerHTML,
                'gh-header-title': headerTitle?.outerHTML,
                'pull-request-header': document.querySelector('.pull-request-header')?.outerHTML,
                'State elements': Array.from(document.querySelectorAll('.State')).map(el => ({
                    text: el.textContent,
                    classes: el.className,
                    html: el.outerHTML
                }))
            });

            if (isDraft || isOpen) {
                console.log('PR is draft or open, proceeding with UI creation');
                
                // Create UI immediately with loading state
                this.createUI();
                const contentArea = document.getElementById('code-owners-content');
                this.showLoading(contentArea);

                // Fetch CODEOWNERS first
                await this.fetchCodeowners();
                
                // Wait for the page to be fully loaded
                if (document.readyState === 'complete') {
                    this.observeFileChanges();
                } else {
                    await new Promise(resolve => {
                        window.addEventListener('load', () => {
                            this.observeFileChanges();
                            resolve();
                        });
                    });
                }

                // Don't update UI here - it will be updated by updateChangedFiles
                // when the file list is ready
            } else {
                console.log('PR is neither draft nor open, not showing UI');
                removeUI();
            }
        } catch (error) {
            console.error('Error in initialize:', error);
        }
    }

    async waitForElement(selector) {
        return new Promise((resolve) => {
            if (document.querySelector(selector)) {
                return resolve();
            }

            const observer = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    observer.disconnect();
                    resolve();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // Timeout after 10 seconds
            setTimeout(() => {
                observer.disconnect();
                resolve();
            }, 10000);
        });
    }

    async waitForPRState() {
        return new Promise((resolve) => {
            const checkState = () => {
                const stateElement = document.querySelector('.State') || 
                                   document.querySelector('[data-pull-is-draft]') ||
                                   document.querySelector('.js-issue-title');
                
                if (stateElement) {
                    console.log('Found PR state element:', stateElement.outerHTML);
                    resolve();
                    return;
                }
                
                setTimeout(checkState, 100);  // Check every 100ms
            };
            
            checkState();
            
            // Timeout after 10 seconds
            setTimeout(resolve, 10000);
        });
    }

    async fetchCodeowners() {
        console.log('Fetching CODEOWNERS file...');
        try {
            // Get the current repository from the URL
            const pathParts = window.location.pathname.split('/');
            const org = pathParts[1];  // mceSystems
            const repo = pathParts[2];  // mce

            // Try to get the content from the current page
            const codeownersContent = await this.extractCodeOwnersFromPage();
            if (codeownersContent) {
                console.log('Found CODEOWNERS content in page');
                this.parseCodeowners(codeownersContent);
                return;
            }

            // If that fails, try to get it from the repository directly
            const codeownersUrl = `https://github.com/${org}/${repo}/raw/develop/.github/CODEOWNERS`;
            console.log('Trying to fetch from:', codeownersUrl);
            
            const response = await fetch(codeownersUrl);
            if (response.ok) {
                const content = await response.text();
                console.log('Found CODEOWNERS content:', content.substring(0, 200));
                this.parseCodeowners(content);
                return;
            }

            throw new Error('Could not find CODEOWNERS content');
        } catch (error) {
            console.error('Failed to fetch CODEOWNERS:', error);
        }
    }

    async extractCodeOwnersFromPage() {
        // Try to find CODEOWNERS content in the current page's file tree
        const fileTree = document.querySelector('.js-diff-progressive-container');
        if (!fileTree) return null;

        // Look for .github/CODEOWNERS file in the tree
        const fileLinks = Array.from(fileTree.querySelectorAll('.file-info'));
        const codeownersFile = fileLinks.find(link => 
            link.getAttribute('data-path')?.endsWith('.github/CODEOWNERS')
        );

        if (codeownersFile) {
            const fileContent = codeownersFile.closest('.file')?.querySelector('.blob-wrapper');
            if (fileContent) {
                return Array.from(fileContent.querySelectorAll('.blob-code-inner'))
                    .map(line => line.textContent)
                    .join('\n');
            }
        }

        return null;
    }

    async getCodeownersFromPage() {
        // Try to find it in the current page if we're looking at the CODEOWNERS file
        const blobWrapper = document.querySelector('.blob-wrapper');
        if (blobWrapper) {
            const lines = Array.from(blobWrapper.querySelectorAll('.blob-code-inner'))
                .map(el => el.textContent)
                .join('\n');
            if (lines) return lines;
        }

        // Try to find it in the raw content
        const rawButton = document.querySelector('a[data-testid="raw-button"]');
        if (rawButton) {
            const rawUrl = rawButton.href;
            const response = await fetch(rawUrl);
            if (response.ok) {
                return await response.text();
            }
        }

        return null;
    }

    async fetchFileContent(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) return null;
            
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Try to get content from blob wrapper
            const lines = Array.from(doc.querySelectorAll('.blob-code-inner'))
                .map(el => el.textContent)
                .join('\n');
                
            return lines || null;
        } catch (error) {
            console.error('Error fetching file content:', error);
            return null;
        }
    }

    parseCodeowners(content) {
        console.log('Parsing CODEOWNERS content...');
        this.codeownersMap.clear();
        
        if (!content) {
            console.error('No content to parse');
            return;
        }
        
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.startsWith('#') || !line.trim()) continue;
            
            const [pattern, ...owners] = line.trim().split(/\s+/);
            console.log('Processing pattern:', pattern, 'owners:', owners);
            
            if (!pattern || owners.length === 0) continue;
            
            try {
                // Convert GitHub glob pattern to regex
                // Store the original pattern for specificity calculations
                const originalPattern = pattern;
                
                // Special handling for file extension patterns like **/*.graphql
                let cleanPattern;
                const fileExtensionMatch = pattern.match(/\/\*\*\/\*\.([a-zA-Z0-9]+)$/);
                
                if (fileExtensionMatch) {
                    // This is a pattern like /path/**/*.graphql
                    const extension = fileExtensionMatch[1];
                    const basePath = pattern.substring(0, pattern.indexOf('/**/'));
                    
                    // Create a regex that matches any file with this extension in any subdirectory
                    cleanPattern = basePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape special characters
                        .replace(/^\//,'') // remove leading slash
                        + '(?:/.*)?\\.' + extension + '$';
                    
                    console.log(`Special extension pattern ${pattern} converted to: ${cleanPattern}`);
                } else if (pattern.includes('**/')) {
                    // Handle **/ pattern to match any number of directory levels
                    cleanPattern = pattern
                        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape special characters
                        .replace(/\*\*\//g, '(?:.*/)?') // convert **/ to match any number of directories
                        .replace(/\*/g, '[^/]*') // convert remaining * to [^/]*
                        .replace(/^\//,'') // remove leading slash
                        .replace(/\/$/,''); // remove trailing slash
                } else {
                    cleanPattern = pattern
                        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape special characters
                        .replace(/\*\*/g, '.*') // convert ** to .*
                        .replace(/\*/g, '[^/]*') // convert * to [^/]*
                        .replace(/^\//,'') // remove leading slash
                        .replace(/\/$/,''); // remove trailing slash
                }
                
                console.log('Converted pattern:', pattern, 'to regex:', cleanPattern);
                const regex = new RegExp(`^${cleanPattern}`);
                owners.forEach(owner => {
                    if (!this.codeownersMap.has(owner)) {
                        this.codeownersMap.set(owner, new Set());
                    }
                    // Store the regex and original pattern
                    const patternObj = { regex, originalPattern };
                    this.codeownersMap.get(owner).add(patternObj);
                });
            } catch (error) {
                console.error('Failed to create regex for pattern:', pattern, error);
            }
        }
        
        console.log('Finished parsing. Found owners:', Array.from(this.codeownersMap.keys()));
        
        this._parsedPatterns = this.codeownersMap;
        return this.codeownersMap;
    }

    observeFileChanges() {
        console.log('Setting up file change observer...');
        // Wait for the file list to be available
        const waitForFiles = () => {
            const fileList = document.querySelector('.js-diff-progressive-container');
            if (!fileList) {
                console.log('File list not found, retrying in 1s...');
                setTimeout(waitForFiles, 1000);
                return;
            }

            // Initial update
            this.updateChangedFiles();

            // Set up observer for dynamic updates during initial load only
            const observer = new MutationObserver((mutations) => {
                // Only process mutations that actually change the file list
                const relevantChanges = mutations.some(mutation => {
                    // Check if nodes were added/removed
                    if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
                        // Verify the changes are file-related
                        return Array.from(mutation.addedNodes).some(node => 
                            node.classList?.contains('file') ||
                            node.querySelector?.('.file')
                        ) || Array.from(mutation.removedNodes).some(node => 
                            node.classList?.contains('file') ||
                            node.querySelector?.('.file')
                        );
                    }
                    return false;
                });

                if (relevantChanges) {
                    console.log('File changes detected - updating file list');
                    this.updateChangedFiles();
                    
                    // Check if all files are loaded
                    const filesCounter = document.querySelector('#files_tab_counter');
                    const expectedCount = parseInt(filesCounter?.getAttribute('title') || '0');
                    const currentCount = document.querySelectorAll('.file').length;
                    
                    if (currentCount >= expectedCount && expectedCount > 0) {
                        console.log('All files loaded, disconnecting observer');
                        observer.disconnect();
                    }
                }
            });

            observer.observe(fileList, { 
                childList: true, 
                subtree: true
            });
        };

        waitForFiles();
    }

    async updateChangedFiles() {
        this.log('Updating changed files...', 'info');
        
        // Reset tracking sets
        this.filesWithOwners = new Set();
        this.filesWithoutOwners = new Set();
        
        // Wait for the progressive loading to complete
        await this.waitForAllFiles();
        
        const files = document.querySelectorAll('.file');
        this.changedFiles.clear();
        
        this.log(`Processing ${files.length} files...`, 'info');
        
        // Process files in smaller batches for better performance with large PRs
        const BATCH_SIZE = 20;
        let processed = 0;
        
        const processNextBatch = () => {
            const batch = Array.from(files).slice(processed, processed + BATCH_SIZE);
            
            batch.forEach(file => {
                // Try multiple selectors to find the file path
                const fileHeader = file.querySelector('.file-header');
                const path = fileHeader?.getAttribute('data-path') || 
                            file.querySelector('.file-info a')?.getAttribute('title') ||
                            file.querySelector('.file-info')?.getAttribute('data-path');
                
                if (path) {
                    if (this.DEBUG_MODE) {
                        this.log('Found changed file:', path, 'debug');
                    }
                    this.changedFiles.add(path);
                } else {
                    this.log('Could not find path for file:', file.innerHTML, 'warn');
                }
            });
            
            processed += batch.length;
            
            // If there are more files to process, schedule the next batch
            if (processed < files.length) {
                setTimeout(processNextBatch, 0); // Use setTimeout to avoid blocking the UI
            } else {
                this.log('Total files found:', this.changedFiles.size, 'info');
                
                // Only update UI if we have files and this is not the initial load
                if (this.changedFiles.size > 0) {
                    this.updateUI();
                }
            }
        };
        
        // Start processing the first batch
        processNextBatch();
    }

    async waitForAllFiles() {
        return new Promise(resolve => {
            const checkForLoadingIndicator = () => {
                const progressiveContainer = document.querySelector('.js-diff-progressive-container');
                const loadingIndicator = document.querySelector('.js-diff-progressive-spinner');
                const fileCount = document.querySelectorAll('.file').length;
                
                // Get file count from the Files tab counter
                const filesCounter = document.querySelector('#files_tab_counter');
                const expectedCount = parseInt(filesCounter?.getAttribute('title') || '0');

                console.log(`Waiting for files to load... Current: ${fileCount}, Expected: ${expectedCount}, Counter: "${filesCounter?.getAttribute('title')}"`);
                
                if (!loadingIndicator && (!progressiveContainer || fileCount === expectedCount)) {
                    if (fileCount === 0 || expectedCount === 0) {
                        // If we got 0 files or expected count, wait a bit longer and try again
                        setTimeout(checkForLoadingIndicator, 500);
                        return;
                    }
                    console.log('All files loaded');
                    resolve();
                } else {
                    setTimeout(checkForLoadingIndicator, 100);
                }
            };
            
            checkForLoadingIndicator();
        });
    }

    async getApprovedReviewers() {
        const approvedReviewers = new Set();
        
        try {
            const prMatch = window.location.pathname.match(/\/pull\/(\d+)/);
            const prNumber = prMatch ? prMatch[1] : '';
            const pathParts = window.location.pathname.split('/');
            const org = pathParts[1];
            const repo = pathParts[2];
            
            console.log('Fetching approvals for PR:', { org, repo, prNumber });
            if (!prNumber) {
                console.error('Could not extract PR number from URL');
                return approvedReviewers;
            }
            
            // Fetch the conversation page
            const response = await fetch(`https://github.com/${org}/${repo}/pull/${prNumber}`);
            if (!response.ok) {
                console.error('Failed to fetch conversation page:', response.status);
                return approvedReviewers;
            }
            
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            
            // Find all review items
            const reviewItems = doc.querySelectorAll('.js-timeline-item');
            console.log('Found timeline items:', reviewItems.length);
            
            reviewItems.forEach(item => {
                // Look for approval indicators
                const hasApproval = item.querySelector('.octicon-check.color-fg-success') || 
                                  item.querySelector('[title*="approved these changes"]') ||
                                  item.textContent.includes('approved these changes');
                
                if (hasApproval) {
                    // Try multiple ways to find the reviewer
                    const reviewer = item.querySelector('.author') || 
                                   item.querySelector('.Link--primary') ||
                                   item.querySelector('[data-hovercard-type="user"]');
                    
                    if (reviewer) {
                        const reviewerName = '@' + reviewer.textContent.trim();
                        console.log('Found approval from:', reviewerName);
                        approvedReviewers.add(reviewerName);
                    }
                }
            });

            // Also check the review summary section
            const summarySection = doc.querySelector('.js-reviews-container');
            if (summarySection) {
                const approvedItems = summarySection.querySelectorAll('.color-fg-success');
                approvedItems.forEach(item => {
                    const summaryItem = item.closest('.review-summary-form-container');
                    if (summaryItem) {
                        const reviewer = summaryItem.querySelector('.Link--primary, .author, [data-hovercard-type="user"]');
                        if (reviewer) {
                            const reviewerName = '@' + reviewer.textContent.trim();
                            console.log('Found approval in summary from:', reviewerName);
                            approvedReviewers.add(reviewerName);
                        }
                    }
                });
            }

            // Also check the PR header for approved reviews
            const headerReviews = doc.querySelectorAll('.pull-header-participating .participation-avatars .avatar');
            headerReviews.forEach(avatar => {
                const isApproved = avatar.closest('.approved') || 
                                 avatar.getAttribute('title')?.includes('approved');
                if (isApproved) {
                    const reviewer = avatar.getAttribute('alt')?.replace('@', '');
                    if (reviewer) {
                        const reviewerName = '@' + reviewer;
                        console.log('Found approval in header from:', reviewerName);
                        approvedReviewers.add(reviewerName);
                    }
                }
            });

            console.log('Final approved reviewers:', Array.from(approvedReviewers));
        } catch (error) {
            console.error('Failed to get approved reviewers:', error);
        }
        
        return approvedReviewers;
    }

    getFileOwners(filePath) {
        // Check if we've already determined owners for this file
        if (this._fileOwnersCache && this._fileOwnersCache[filePath]) {
            return this._fileOwnersCache[filePath];
        }
        
        // Initialize cache if not exists
        if (!this._fileOwnersCache) {
            this._fileOwnersCache = {};
        }
        
        const owners = new Set();
        let mostSpecificPattern = '';
        let mostSpecificOwners = new Set();
        let highestSpecificityScore = -1;

        // First collect all patterns and their owners
        const patternMap = new Map(); // pattern string -> Set of owners
        this.codeownersMap.forEach((patterns, owner) => {
            patterns.forEach(patternObj => {
                if (patternObj.regex.test(filePath)) {
                    const patternStr = patternObj.originalPattern;
                    if (!patternMap.has(patternStr)) {
                        patternMap.set(patternStr, new Set());
                    }
                    patternMap.get(patternStr).add(owner);
                }
            });
        });

        // Find the most specific pattern using a better specificity scoring method
        patternMap.forEach((patternOwners, patternStr) => {
            // Calculate specificity score
            const specificityScore = this.calculatePatternSpecificity(patternStr, filePath);
            if (this.DEBUG_MODE) {
                this.log(`Pattern ${patternStr} for file ${filePath} has specificity score: ${specificityScore}`, 'debug');
            }
            
            if (specificityScore > highestSpecificityScore) {
                highestSpecificityScore = specificityScore;
                mostSpecificPattern = patternStr;
                mostSpecificOwners = patternOwners;
            }
        });

        // Add all owners from the most specific pattern
        if (mostSpecificOwners.size > 0) {
            mostSpecificOwners.forEach(owner => owners.add(owner));
        }

        if (this.DEBUG_MODE || owners.size === 0) {
            this.log(`Found ${owners.size} owners for file ${filePath} (pattern: ${mostSpecificPattern}, score: ${highestSpecificityScore}):`, 
                     owners.size > 0 ? 'info' : 'warn', 
                     Array.from(owners));
        }
        
        // Track the file in the appropriate set
        if (owners.size > 0) {
            this.filesWithOwners.add(filePath);
        } else {
            this.filesWithoutOwners.add(filePath);
        }
        
        // Cache the result before returning
        this._fileOwnersCache[filePath] = owners;
        return owners;
    }

    calculatePatternSpecificity(patternStr, filePath) {
        // Higher scores mean more specific patterns
        let score = 0;
        
        // Extract file extension from file path
        const fileExtension = filePath.split('.').pop();
        
        // Special handling for **/*.ext patterns - these should have the highest priority for matching files
        if (patternStr.match(/\/\*\*\/\*\.[a-zA-Z0-9]+$/) && 
            patternStr.endsWith('*.' + fileExtension)) {
            score += 1000; // Super high boost for exact file extension pattern match
            if (this.DEBUG_MODE) {
                this.log(`EXTENSION MATCH: Added 1000 points for ${patternStr} matching file with extension ${fileExtension}`, 'debug');
            }
        }
        
        // For general file extension pattern matches without **
        else if (fileExtension && patternStr.includes('.' + fileExtension)) {
            score += 100;
            if (this.DEBUG_MODE) {
                this.log(`Added 100 points for pattern with extension .${fileExtension}`, 'debug');
            }
        }
        
        // For patterns with * wildcards matching file extensions
        if (patternStr.includes('*.' + fileExtension)) {
            score += 50;
            if (this.DEBUG_MODE) {
                this.log(`Added 50 points for *.${fileExtension} pattern match`, 'debug');
            }
        }
        
        // REDUCED PENALTY - If the pattern is a directory pattern and not a file pattern
        if ((patternStr.endsWith('/') || !patternStr.includes('.')) && fileExtension) {
            score -= 5; // Small penalty
            if (this.DEBUG_MODE) {
                this.log(`Minor penalty: Reduced 5 points for directory pattern ${patternStr} matching a file with extension`, 'debug');
            }
        }
        
        // START WITH A BASE SCORE to avoid negative values
        score += 10;
        
        // Count path segments (more segments = more specific)
        const segments = patternStr.split('/').filter(s => s.length > 0);
        const segmentScore = segments.length * 5;
        score += segmentScore;
        
        // Add points for exact match segments (those without wildcards)
        const exactSegments = segments.filter(s => !s.includes('*')).length;
        const exactSegmentScore = exactSegments * 5;
        score += exactSegmentScore;
        
        // Path depth - boost score if pattern matches the specific directory structure
        const pathSegments = filePath.split('/');
        let matchingSegments = 0;
        
        for (let i = 0; i < Math.min(segments.length, pathSegments.length); i++) {
            if (segments[i] === pathSegments[i]) {
                matchingSegments++;
            }
        }
        
        score += matchingSegments * 5;
        
        // Smaller penalty for wildcards
        const wildcardCount = (patternStr.match(/\*/g) || []).length;
        score -= wildcardCount;  // Reduced from wildcardCount * 2 to just wildcardCount
        
        if (this.DEBUG_MODE) {
            this.log(`Final score for pattern ${patternStr} with file ${filePath}: ${score}`, 'debug');
        }
        return score;
    }

    async getPRAuthor() {
        try {
            // Use the reliable selector that works for finding the PR author
            const authorElement = document.querySelector('.gh-header-meta .author');
            if (authorElement) {
                const author = '@' + authorElement.textContent.trim();
                console.log('Found PR author:', author);
                return author;
            }

            console.warn('Could not find PR author');
            return null;
        } catch (error) {
            console.error('Error getting PR author:', error);
            return null;
        }
    }

    analyzeOwnership() {
        const fullCoverageOwners = new Set();
        const ownerToFiles = new Map();
        this.log('Analyzing ownership for files:', this.DEBUG_MODE ? 'info' : 'debug', Array.from(this.changedFiles));

        // Get PR author to exclude them
        const prAuthor = this.prAuthor;
        this.log('PR author to exclude:', 'info', prAuthor);

        // Map owners to their covered files and track files that have owners
        this.changedFiles.forEach(file => {
            const fileOwners = this.getFileOwners(file);
            if (fileOwners.size > 0) {
                fileOwners.forEach(owner => {
                    // Skip the PR author
                    if (owner === prAuthor) return;

                    if (!ownerToFiles.has(owner)) {
                        ownerToFiles.set(owner, new Set());
                    }
                    ownerToFiles.get(owner).add(file);
                });
            } else if (this.DEBUG_MODE) {
                this.log(`File ${file} has no owners - will be ignored for coverage`, 'debug');
            }
        });

        // Find owners with full coverage (of files that have owners)
        ownerToFiles.forEach((files, owner) => {
            if (files.size === this.filesWithOwners.size) {
                fullCoverageOwners.add(owner);
            }
        });

        if (this.DEBUG_MODE) {
            this.log('Owner to files mapping:', 'debug', 
                    Object.fromEntries([...ownerToFiles].map(([k, v]) => [k, Array.from(v)])));
        }
        this.log('Full coverage owners:', 'info', Array.from(fullCoverageOwners));

        // Find combined sets of owners for full coverage
        const combinedSets = this.findCombinedOwnerSet(ownerToFiles);
        this.log('Combined Coverage Sets:', 'info', combinedSets);

        return {
            fullCoverageOwners: Array.from(fullCoverageOwners),
            combinedSets: combinedSets,
            fileStats: {
                total: this.changedFiles.size,
                withOwners: this.filesWithOwners.size,
                withoutOwners: this.filesWithoutOwners.size
            }
        };
    }

    findCombinedOwnerSet(ownerToFiles) {
        const owners = Array.from(ownerToFiles.keys());
        
        if (this.DEBUG_MODE) {
            this.log('Finding combined set for files:', 'debug', Array.from(this.filesWithOwners));
            this.log('Available owners:', 'debug', owners);
        }

        // First find owners with full coverage
        const fullCoverageOwners = new Set();
        ownerToFiles.forEach((files, owner) => {
            // Skip PR author
            if (owner === this.prAuthor) return;

            if (files.size === this.filesWithOwners.size) {
                fullCoverageOwners.add(owner);
            }
        });

        // Remove full coverage owners and PR author from consideration
        const partialOwners = owners.filter(owner => 
            !fullCoverageOwners.has(owner) && owner !== this.prAuthor
        );
        
        if (partialOwners.length === 0) {
            this.log('No partial coverage owners found', 'info');
            return [];
        }

        let combinedSets = [];
        
        // Cache owner file coverage for better performance
        const ownerCoverage = new Map();
        partialOwners.forEach(owner => {
            ownerCoverage.set(owner, new Set(ownerToFiles.get(owner)));
        });

        // Helper function to get combination coverage - optimized with cached owner coverage
        const getCoverage = (combination) => {
            const covered = new Set();
            combination.forEach(owner => {
                const ownerFiles = ownerCoverage.get(owner);
                ownerFiles.forEach(file => covered.add(file));
            });
            return covered;
        };

        // Helper function to check if a combination is redundant (optimized)
        const isRedundantCombination = (combination) => {
            // For each existing valid set
            for (const validSet of combinedSets) {
                // If all members of a valid set are in this combination, it's redundant
                let isSuperset = true;
                for (const owner of validSet) {
                    if (!combination.includes(owner)) {
                        isSuperset = false;
                        break;
                    }
                }
                if (isSuperset) return true;
            }
            return false;
        };
                
        combinationLoop:
        for (let i = 1; i <= Math.min(this.MAX_COMBINATION_SIZE, partialOwners.length); i++) {
            this.log(`Trying combinations of ${i} partial owners...`, 'info');
            
            // Optimization: Avoid generating all combinations at once
            // Instead, generate and process them one by one
            const combinations = this.getCombinations(partialOwners, i);
            
            for (const combination of combinations) {
                // Exit early if we've found enough combinations
                if (combinedSets.length >= this.MAX_COMBINATIONS_TO_SHOW) {
                    this.log(`Reached maximum of ${this.MAX_COMBINATIONS_TO_SHOW} combinations, stopping search`, 'info');
                    break combinationLoop;
                }
                
                // Skip this combination if it's a superset of an existing valid combination
                if (isRedundantCombination(combination)) {
                    // Only log occasionally to reduce console spam
                    if (this.DEBUG_MODE && Math.random() < 0.01) {
                        this.log(`Skipping redundant combination: ${combination}`, 'debug');
                    }
                    continue;
                }
                
                const coverage = getCoverage(combination);
                
                // Add combinations that provide full coverage
                if (coverage.size === this.filesWithOwners.size) {
                    combinedSets.push(combination);
                    this.log('Found valid combination:', 'info', combination);
                }
            }
        }

        // Sort combinations by size for better UX (smaller combinations first)
        combinedSets.sort((a, b) => {
            // First sort by length
            if (a.length !== b.length) return a.length - b.length;
            
            // Then by approved status count (combinations with more approved reviewers first)
            const aApprovedCount = a.filter(owner => this.approvedReviewers?.has(owner)).length;
            const bApprovedCount = b.filter(owner => this.approvedReviewers?.has(owner)).length;
            return bApprovedCount - aApprovedCount;
        });
        
        return combinedSets;
    }

    getCombinations(arr, k) {
        const combinations = [];
        
        function backtrack(start, combination) {
            if (combination.length === k) {
                combinations.push([...combination]);
                return;
            }
            
            for (let i = start; i < arr.length; i++) {
                combination.push(arr[i]);
                backtrack(i + 1, combination);
                combination.pop();
            }
        }
        
        backtrack(0, []);
        return combinations;
    }

    createUI() {
        console.log('Creating UI panel...');
        // Remove existing panel if any
        removeUI();

        // Create panel container
        const panel = document.createElement('div');
        panel.className = 'color-bg-default color-fg-default border rounded-2 code-owners-panel';
        panel.style.cssText = `
            top: 100px;
            right: 30px;
            width: 280px;
            display: flex;
            flex-direction: column;
            max-height: 80vh; /* Limit the panel height */
        `;

        // Create header with close button
        const header = document.createElement('div');
        header.className = 'd-flex flex-items-center p-2 code-owners-header';
        header.style.cssText = 'cursor: move; flex-shrink: 0;'; // prevent header from shrinking
        header.innerHTML = `
            <div class="flex-1" style="user-select: none;">GitHub PR Code Owners Analyzer</div>
            <div class="d-flex">
                <button class="btn-octicon" id="code-owners-collapse">
                    <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill="currentColor" d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
                    </svg>
                </button>
                <button class="btn-octicon" id="code-owners-close">
                    <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path>
                    </svg>
                </button>
            </div>
        `;

        // Add double-click handler for the header
        const headerTitle = header.querySelector('.flex-1');
        headerTitle.addEventListener('dblclick', () => {
            const collapseButton = document.getElementById('code-owners-collapse');
            collapseButton.click();
        });

        // Create scrollable content container
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'scrollable-content';
        contentWrapper.style.cssText = `
            overflow-y: auto;
            flex-grow: 1;
            max-height: calc(80vh - 90px); /* Adjust for header and status bar */
        `;

        const content = document.createElement('div');
        content.className = 'p-3';
        content.id = 'code-owners-content';
        contentWrapper.appendChild(content);

        // Create fixed status bar
        const statusBar = document.createElement('div');
        statusBar.className = 'status-bar py-1 px-2 color-bg-subtle f6 color-fg-muted';
        statusBar.id = 'status-bar';
        statusBar.style.cssText = `
            border-top: 1px solid var(--color-border-muted);
            border-bottom-left-radius: 6px;
            border-bottom-right-radius: 6px;
            flex-shrink: 0;
        `;
        
        // Add a span for the status text
        const statusText = document.createElement('span');
        statusText.id = 'status-text';
        statusText.textContent = 'Loading...';
        statusBar.appendChild(statusText);

        panel.appendChild(header);
        panel.appendChild(contentWrapper);
        panel.appendChild(statusBar);

        document.body.appendChild(panel);

        // Add drag functionality
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;

        header.addEventListener('mousedown', e => {
            isDragging = true;
            initialX = e.clientX - panel.offsetLeft;
            initialY = e.clientY - panel.offsetTop;
        });

        document.addEventListener('mousemove', e => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                panel.style.left = `${currentX}px`;
                panel.style.top = `${currentY}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // Add button handlers after panel is in DOM
        const closeBtn = document.getElementById('code-owners-close');
        const collapseBtn = document.getElementById('code-owners-collapse');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                removeUI(true);
            });
        }

        if (collapseBtn && contentWrapper) {
            collapseBtn.addEventListener('click', () => {
                contentWrapper.style.display = contentWrapper.style.display === 'none' ? 'block' : 'none';
                statusBar.style.display = statusBar.style.display === 'none' ? 'block' : 'none';
                panel.classList.toggle('collapsed');
                collapseBtn.querySelector('svg').style.transform = 
                    contentWrapper.style.display === 'none' ? 'rotate(-90deg)' : 'rotate(0deg)';
            });
        }

        // Show initial loading state
        this.showLoading(content);
        return panel;
    }

    showLoading(contentArea) {
        this.log('Showing loading state...', 'info');
        if (!contentArea) {
            this.log('No content area provided to showLoading', 'error');
            return;
        }
        
        // Fix SVG path error by using a correct SVG spinner
        contentArea.innerHTML = `
            <div class="d-flex flex-column">
                <div class="color-fg-muted">
                    <div class="d-flex flex-items-center">
                        <svg class="mr-2 anim-rotate" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" fill="none" />
                            <path d="M15 8a7.002 7.002 0 00-7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                        </svg>
                        Analyzing code ownership...
                    </div>
                </div>
            </div>
        `;
    }

    showResults(fullCoverageOwners, combinedSets, approvedReviewers, fileStats) {
        this.log('Showing results with approvals:', this.DEBUG_MODE ? 'info' : 'debug', { 
            fullCoverageOwners, 
            combinedSets, 
            approvedReviewers: Array.from(approvedReviewers),
            fileStats
        });
        const contentArea = document.getElementById('code-owners-content');
        if (!contentArea) {
            this.log('Could not find content area to update', 'error');
            return;
        }

        const createOwnerElement = (owner) => {
            const isApproved = approvedReviewers.has(owner);
            if (this.DEBUG_MODE) {
                this.log(`Owner ${owner} approved status:`, 'debug', isApproved);
            }
            const username = owner.substring(1); // Remove @ symbol
            return `
                <li>
                    <img src="https://github.com/${username}.png" alt="${username}" 
                         width="20" height="20" class="avatar" />
                    <a href="https://github.com/${username}" class="Link--primary" target="_blank" rel="noopener noreferrer">${owner}</a>
                    ${isApproved ? '<span class="color-fg-success">✓</span>' : ''}
                </li>`;
        };

        const createCombinedSetElement = (owners) => {
            return `<span class="combined-set">` + owners.map(owner => {
                const isApproved = approvedReviewers.has(owner);
                const username = owner.substring(1); // Remove @ symbol
                if (this.DEBUG_MODE) {
                    this.log(`Combined set owner ${owner} approved status:`, 'debug', isApproved);
                }
                return `
                    <span class="d-inline-flex flex-items-center">
                        <img src="https://github.com/${username}.png" alt="${username}" 
                             width="20" height="20" class="avatar mr-1" />
                        <a href="https://github.com/${username}" class="Link--primary" target="_blank" rel="noopener noreferrer">${owner}</a>
                        ${isApproved ? '<span class="color-fg-success">✓</span>' : ''}
                    </span>`;
            }).join('') + '</span>';
        };

        contentArea.innerHTML = `
            <div class="d-flex flex-column">
                <div class="section">
                    <div class="d-flex flex-items-center mb-2">
                        <button class="btn-octicon mr-2 js-section-toggle" data-target="full-coverage-list">
                            <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill="currentColor" d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
                            </svg>
                        </button>
                        <h3 class="h5 mb-0">Full Coverage Owners</h3>
                        <div class="tooltip-container">
                            <span class="info-icon">
                                <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                    <path fill="currentColor" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/>
                                </svg>
                            </span>
                            <span class="tooltip">These owners can individually approve all changed files</span>
                        </div>
                    </div>
                    <ul id="full-coverage-list" class="owners-list">
                        ${fullCoverageOwners.length 
                            ? fullCoverageOwners.map(createOwnerElement).join('')
                            : '<li class="color-fg-muted">No owners with full coverage</li>'}
                    </ul>
                </div>
                <div class="section">
                    <div class="d-flex flex-items-center mb-2">
                        <button class="btn-octicon mr-2 js-section-toggle" data-target="combined-coverage-list">
                            <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill="currentColor" d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
                            </svg>
                        </button>
                        <h3 class="h5 mb-0">Combined Coverage Sets</h3>
                        <div class="tooltip-container">
                            <span class="info-icon">
                                <svg class="octicon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                    <path fill="currentColor" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/>
                                </svg>
                            </span>
                            <span class="tooltip">These owners together can approve all changed files</span>
                        </div>
                    </div>
                    <ul id="combined-coverage-list" class="owners-list">
                        ${combinedSets.length 
                            ? combinedSets.map((set, index) => `
                                ${index > 0 ? `<li class="border-top color-border-muted"></li>` : ''}
                                <li class="py-2">
                                    ${createCombinedSetElement(set)}
                                </li>`).join('')
                            : '<li class="color-fg-muted">No Combined Coverage Sets found</li>'}
                    </ul>
                </div>
            </div>
        `;

        // Update the status bar with simplified text
        const statusText = document.getElementById('status-text');
        // Only show "has owners" count if not all files have owners
        const statusBarText = fileStats.withOwners < fileStats.total 
            ? `Processed ${fileStats.total} files (${fileStats.withOwners} has owners)`
            : `Processed ${fileStats.total} files`;
        statusText.textContent = statusBarText;

        // Add click handlers for section toggles and double-click for section titles
        contentArea.querySelectorAll('.js-section-toggle').forEach(button => {
            const targetId = button.getAttribute('data-target');
            const targetList = document.getElementById(targetId);
            const icon = button.querySelector('svg');
            const sectionTitle = button.closest('.d-flex').querySelector('.h5');

            // Single click handler for the button
            button.addEventListener('click', () => {
                toggleSection(targetList, icon);
            });

            // Double click handler for the title
            if (sectionTitle) {
                sectionTitle.style.userSelect = 'none';
                sectionTitle.addEventListener('dblclick', () => {
                    toggleSection(targetList, icon);
                });
            }
        });

        // Helper function to toggle section visibility
        function toggleSection(targetList, icon) {
            if (targetList.classList.contains('collapsed')) {
                targetList.classList.remove('collapsed');
                icon.style.transform = 'rotate(0deg)';
            } else {
                targetList.classList.add('collapsed');
                icon.style.transform = 'rotate(-90deg)';
            }
        }

        // Add tooltip functionality
        contentArea.querySelectorAll('.tooltip-container').forEach(container => {
            const tooltip = container.querySelector('.tooltip');
            
            container.addEventListener('mouseenter', (e) => {
                const rect = container.getBoundingClientRect();
                tooltip.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
                tooltip.style.left = (rect.left + rect.width/2) + 'px';
            });
        });

        // Add hover handlers for owners to update the status bar
        const baseStatusText = statusBarText;

        // Add hover handlers for individual owners
        contentArea.querySelectorAll('.owners-list li a').forEach(ownerLink => {
            const owner = ownerLink.textContent;
            const ownerFiles = this.getOwnerFiles(owner);
            
            ownerLink.parentElement.addEventListener('mouseenter', () => {
                if (ownerFiles) {
                    statusText.textContent = `${owner} owns ${ownerFiles.size}/${fileStats.withOwners} files with owners`;
                }
            });
            
            ownerLink.parentElement.addEventListener('mouseleave', () => {
                statusText.textContent = baseStatusText;
            });
        });

        // Add hover handlers for combined set owners
        contentArea.querySelectorAll('.combined-set .d-inline-flex').forEach(ownerElement => {
            const ownerLink = ownerElement.querySelector('a');
            if (ownerLink) {
                const owner = ownerLink.textContent;
                const ownerFiles = this.getOwnerFiles(owner);
                
                ownerElement.addEventListener('mouseenter', () => {
                    if (ownerFiles) {
                        statusText.textContent = `${owner} owns ${ownerFiles.size}/${fileStats.withOwners} files`;
                    }
                });
                
                ownerElement.addEventListener('mouseleave', () => {
                    statusText.textContent = baseStatusText;
                });
            }
        });
    }

    async updateUI() {
        this.log('Updating UI...', 'info');
        const contentArea = document.getElementById('code-owners-content');
        this.showLoading(contentArea);

        try {
            // Get approved reviewers
            const approvedReviewers = await this.getApprovedReviewers();
            
            // Analyze ownership
            const { fullCoverageOwners, combinedSets, fileStats } = this.analyzeOwnership();
            
            // Update UI with results
            this.showResults(fullCoverageOwners, combinedSets, approvedReviewers, fileStats);
        } catch (error) {
            this.log('Error updating UI:', 'error', error);
            if (contentArea) {
                contentArea.innerHTML = `<div class="error-message">Error analyzing code owners: ${error.message}</div>`;
            }
        }
    }

    getOwnerFiles(owner) {
        const files = new Set();
        this.changedFiles.forEach(file => {
            const fileOwners = this.getFileOwners(file);
            if (fileOwners.has(owner)) {
                files.add(file);
            }
        });
        return files;
    }

    calculateMinimumReviewers() {
        // If there's a single owner that covers all files, return early
        if (this.fullCoverageOwners.length > 0) {
            console.log('Found full coverage owners, skipping combination analysis');
            return {
                fullCoverageOwners: this.fullCoverageOwners,
                combinedSets: []
            };
        }
        
        // ... existing combinatorial analysis ...
    }
}

// Modify the removeUI function to only set the flag when explicitly called from the close button
function removeUI(fromCloseButton = false) {
    const existingPanel = document.querySelector('.code-owners-panel');
    if (existingPanel) {
        existingPanel.remove();
    }
    
    // Only set the session flag when explicitly closed with the X button
    if (fromCloseButton) {
        sessionStorage.setItem('codeOwnersPanelClosed', 'true');
    }
}

// Add a function to clear the session flag on page refresh/navigation
function clearSessionFlags() {
    // Check if this is a fresh page load (not a navigation within GitHub SPA)
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        sessionStorage.removeItem('codeOwnersPanelClosed');
    }
}

// Call this function when the page loads
window.addEventListener('load', clearSessionFlags);

// Add a flag to track initialization
let isInitializing = false;

// Add this helper function to safely access storage
async function safeStorageGet(keys) {
    try {
        return await chrome.storage.local.get(keys);
    } catch (error) {
        console.log('Storage access error (expected in some contexts):', error.message);
        // Return a default value
        const result = {};
        if (Array.isArray(keys)) {
            keys.forEach(key => result[key] = null);
        } else if (typeof keys === 'string') {
            result[keys] = null;
        } else if (keys === null) {
            // Return empty object for all keys
        }
        return result;
    }
}

// Modify the initializeAnalyzer function to prevent multiple initializations
async function initializeAnalyzer() {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('Initialization already in progress, skipping');
        return;
    }
    
    isInitializing = true;
    
    try {
        // Clear the session flag on extension initialization
        if (document.readyState === 'complete') {
            sessionStorage.removeItem('codeOwnersPanelClosed');
        }
        
        // Check if extension is enabled before doing anything
        const { enabled } = await safeStorageGet(['enabled']);
        
        // Default to enabled if we couldn't access storage
        if (enabled === null) {
            console.log('Could not access storage, assuming extension is enabled');
        } else if (!enabled) {
            console.log('Extension is disabled, skipping initialization');
            isInitializing = false;
            return;
        }
        
        const analyzer = new CodeOwnersAnalyzer();
        await analyzer.initialize();
    } catch (error) {
        console.error('Error during initialization:', error);
    } finally {
        isInitializing = false;
    }
}

// Handle GitHub's navigation
let lastUrl = location.href;
let lastUrlWithoutFragment = location.href.split('#')[0];

async function handleUrlChange() {
    const url = location.href;
    const urlWithoutFragment = url.split('#')[0];
    
    // Only consider it a navigation if the base URL changes
    if (urlWithoutFragment !== lastUrlWithoutFragment) {
        lastUrl = url;
        lastUrlWithoutFragment = urlWithoutFragment;
        
        if (url.includes('/files')) {
            // Wait for GitHub's content to load
            await new Promise(resolve => setTimeout(resolve, 1000));
            initializeAnalyzer(); // Will check enabled state internally
        } else {
            removeUI();
        }
    }
}

// Then use this function in both event handlers:
new MutationObserver(handleUrlChange).observe(document, { subtree: true, childList: true });
document.addEventListener('turbo:render', handleUrlChange);

// Initialize on page load if we're on the files tab
if (location.href.includes('/files')) {
    initializeAnalyzer(); // Will check enabled state internally
}

// Run on page load
console.log('Content script loaded!');

// Ignore storage errors
window.addEventListener('error', (event) => {
    if (event.message.includes('Access to storage is not allowed')) {
        event.preventDefault();
    }
});

// Add CSS for the animation fix
document.addEventListener('DOMContentLoaded', function() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(359deg); }
        }
        
        .anim-rotate {
            animation: rotate 1s linear infinite;
        }
    `;
    document.head.appendChild(style);
}); 