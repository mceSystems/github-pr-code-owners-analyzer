class CodeOwnersAnalyzer {
    constructor() {
        console.log('CodeOwnersAnalyzer constructor called');
        this.codeownersMap = new Map();
        this.changedFiles = new Set();
        this.approvedReviewers = new Set();
    }

    async initialize() {
        console.log('Initializing CodeOwnersAnalyzer...');
        
        // Check if panel was explicitly closed this session
        if (sessionStorage.getItem('codeOwnersPanelClosed') === 'true') {
            console.log('Panel was explicitly closed this session, not showing UI');
            return;
        }
        
        try {
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

            // Check if PR is merged first
            const mergeStatus = document.querySelector('.State--merged');
            if (mergeStatus) {
                console.log('PR is merged, not showing UI');
                return;
            }

            // Show UI for both draft and open PRs
            const draftDataAttr = document.querySelector('[data-pull-is-draft="true"]');
            const draftState = document.querySelector('.State--draft');
            const draftLabel = document.querySelector('.js-draft-label');
            const prTitle = document.querySelector('.js-issue-title');
            const prHeader = document.querySelector('.gh-header-title');
            const prStateLabel = document.querySelector('.State');
            
            // Additional draft indicators
            const isDraftByData = !!draftDataAttr;
            const isDraftByStateClass = !!draftState;
            const isDraftByLabel = !!draftLabel;
            const isDraftByTitle = !!(prTitle && prTitle.textContent.toLowerCase().includes('draft:'));
            const isDraftByHeader = !!(prHeader && prHeader.textContent.toLowerCase().includes('draft:'));
            const isDraftByStateText = !!(prStateLabel && prStateLabel.textContent.toLowerCase().includes('draft'));
            
            const isDraft = isDraftByData || isDraftByStateClass || isDraftByLabel || isDraftByTitle || isDraftByHeader || isDraftByStateText;
            const isOpen = document.querySelector('.State--open') || (prStateLabel && prStateLabel.textContent.toLowerCase().includes('open'));
            
            console.log('Draft PR detection details:', {
                'data-pull-is-draft': isDraftByData,
                'State--draft class': isDraftByStateClass,
                'js-draft-label class': isDraftByLabel,
                'Title contains draft': isDraftByTitle,
                'Header contains draft': isDraftByHeader,
                'State label text': prStateLabel?.textContent,
                isDraft,
                isOpen: !!isOpen,
                'PR Title': prTitle?.textContent,
                'PR Header': prHeader?.textContent
            });

            // Log all state-related elements for debugging
            console.log('All state elements:', {
                'gh-header-meta': document.querySelector('.gh-header-meta')?.outerHTML,
                'gh-header-title': document.querySelector('.gh-header-title')?.outerHTML,
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
                let cleanPattern = pattern
                    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape special characters
                    .replace(/\*\*/g, '.*') // convert ** to .*
                    .replace(/\*/g, '[^/]*') // convert * to [^/]*
                    .replace(/^\//,'') // remove leading slash
                    .replace(/\/$/,''); // remove trailing slash

                console.log('Converted pattern:', pattern, 'to regex:', cleanPattern);
                const regex = new RegExp(`^${cleanPattern}(?:/.*)?$`);
                owners.forEach(owner => {
                    if (!this.codeownersMap.has(owner)) {
                        this.codeownersMap.set(owner, new Set());
                    }
                    this.codeownersMap.get(owner).add(regex);
                });
            } catch (error) {
                console.error('Failed to create regex for pattern:', pattern, error);
            }
        }
        
        console.log('Finished parsing. Found owners:', Array.from(this.codeownersMap.keys()));
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
        console.log('Updating changed files...');
        
        // Wait for the progressive loading to complete
        await this.waitForAllFiles();
        
        const files = document.querySelectorAll('.file');
        this.changedFiles.clear();
        
        files.forEach(file => {
            // Try multiple selectors to find the file path
            const fileHeader = file.querySelector('.file-header');
            const path = fileHeader?.getAttribute('data-path') || 
                        file.querySelector('.file-info a')?.getAttribute('title') ||
                        file.querySelector('.file-info')?.getAttribute('data-path');
            
            if (path) {
                console.log('Found changed file:', path);
                this.changedFiles.add(path);
            } else {
                console.warn('Could not find path for file:', file.innerHTML);
            }
        });
        
        console.log('Total files found:', this.changedFiles.size);
        
        // Only update UI if we have files and this is not the initial load
        if (this.changedFiles.size > 0) {
            this.updateUI();
        }
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
        const owners = new Set();
        let mostSpecificPattern = '';
        let mostSpecificOwners = new Set();

        // First collect all patterns and their owners
        const patternMap = new Map(); // pattern string -> Set of owners
        this.codeownersMap.forEach((patterns, owner) => {
            patterns.forEach(pattern => {
                if (pattern.test(filePath)) {
                    const patternStr = pattern.toString().replace(/[\\^$.*+?()[\]{}|]/g, '');
                    if (!patternMap.has(patternStr)) {
                        patternMap.set(patternStr, new Set());
                    }
                    patternMap.get(patternStr).add(owner);
                }
            });
        });

        // Find the most specific pattern
        let longestLength = 0;
        patternMap.forEach((patternOwners, patternStr) => {
            if (patternStr.length > longestLength) {
                longestLength = patternStr.length;
                mostSpecificPattern = patternStr;
                mostSpecificOwners = patternOwners;
            }
        });

        // Add all owners from the most specific pattern
        if (mostSpecificOwners.size > 0) {
            mostSpecificOwners.forEach(owner => owners.add(owner));
        }

        console.log(`Found ${owners.size} owners for file ${filePath} (pattern: ${mostSpecificPattern}):`, Array.from(owners));
        return owners;
    }

    analyzeOwnership() {
        const fullCoverageOwners = new Set();
        const ownerToFiles = new Map();
        const filesWithOwners = new Set();
        console.log('Analyzing ownership for files:', Array.from(this.changedFiles));

        // Map owners to their covered files and track files that have owners
        this.changedFiles.forEach(file => {
            const fileOwners = this.getFileOwners(file);
            if (fileOwners.size > 0) {
                filesWithOwners.add(file);
                fileOwners.forEach(owner => {
                    if (!ownerToFiles.has(owner)) {
                        ownerToFiles.set(owner, new Set());
                    }
                    ownerToFiles.get(owner).add(file);
                });
            } else {
                console.log(`File ${file} has no owners - will be ignored for coverage`);
            }
        });

        // Find owners with full coverage (of files that have owners)
        ownerToFiles.forEach((files, owner) => {
            if (files.size === filesWithOwners.size) {
                fullCoverageOwners.add(owner);
            }
        });

        console.log('Owner to files mapping:', Object.fromEntries([...ownerToFiles].map(([k, v]) => [k, Array.from(v)])));
        console.log('Full coverage owners:', Array.from(fullCoverageOwners));

        // Find combined sets of owners for full coverage
        const combinedSets = this.findCombinedOwnerSet(ownerToFiles, filesWithOwners);
        console.log('Combined Coverage Sets:', combinedSets);

        return {
            fullCoverageOwners: Array.from(fullCoverageOwners),
            combinedSets: combinedSets
        };
    }

    findCombinedOwnerSet(ownerToFiles, filesWithOwners) {
        const owners = Array.from(ownerToFiles.keys());
        
        console.log('Finding combined set for files:', Array.from(filesWithOwners));
        console.log('Available owners:', owners);

        // First find owners with full coverage
        const fullCoverageOwners = new Set();
        ownerToFiles.forEach((files, owner) => {
            if (files.size === filesWithOwners.size) {
                fullCoverageOwners.add(owner);
            }
        });

        // Remove full coverage owners from consideration
        const partialOwners = owners.filter(owner => !fullCoverageOwners.has(owner));
        
        if (partialOwners.length === 0) {
            console.log('No partial coverage owners found');
            return [];
        }

        let combinedSets = [];

        // Helper function to get combination coverage
        const getCoverage = (combination) => {
            const covered = new Set();
            combination.forEach(owner => {
                ownerToFiles.get(owner).forEach(file => covered.add(file));
            });
            return covered;
        };

        // Try combinations of partial owners
        for (let i = 1; i <= Math.min(3, partialOwners.length); i++) {
            console.log(`Trying combinations of ${i} partial owners...`);
            const combinations = this.getCombinations(partialOwners, i);
            
            for (const combination of combinations) {
                const coverage = getCoverage(combination);
                console.log(`Combination ${combination} covers ${coverage.size}/${filesWithOwners.size} files`);
                
                // Only consider combinations that provide full coverage
                if (coverage.size === filesWithOwners.size) {
                    combinedSets.push(combination);
                    console.log('Found valid combination:', combination);
                }
            }
            
            // If we found valid combinations at this size, no need to try larger combinations
            if (combinedSets.length > 0) break;
        }

        // Sort by combination size (smaller is better)
        combinedSets.sort((a, b) => a.length - b.length);
        
        // Return up to 3 best combinations
        return combinedSets.slice(0, 3);
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
        `;

        // Create header with close button
        const header = document.createElement('div');
        header.className = 'd-flex flex-items-center p-2 code-owners-header';
        header.style.cssText = 'cursor: move;';
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

        // Create content container
        const content = document.createElement('div');
        content.className = 'p-3';
        content.id = 'code-owners-content';

        panel.appendChild(header);
        panel.appendChild(content);

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
        const contentArea = document.getElementById('code-owners-content');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                removeUI(true);
            });
        }

        if (collapseBtn && contentArea) {
            collapseBtn.addEventListener('click', () => {
                content.style.display = content.style.display === 'none' ? 'block' : 'none';
                panel.classList.toggle('collapsed');
                collapseBtn.querySelector('svg').style.transform = 
                    content.style.display === 'none' ? 'rotate(-90deg)' : 'rotate(0deg)';
            });
        }

        // Show initial loading state
        this.showLoading(contentArea);
        return panel;
    }

    showLoading(contentArea) {
        console.log('Showing loading state...');
        if (!contentArea) {
            console.error('No content area provided to showLoading');
            return;
        }
        contentArea.innerHTML = `
            <div class="d-flex flex-column">
                <div class="color-fg-muted">
                    <div class="d-flex flex-items-center">
                        <svg style="animation: spin 1s linear infinite;" class="mr-2" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M8 4C8.55228 4 9 3.55228 9 3C9 2.44772 8.55228 2 8 2C7.44772 2 7 2.44772 7 3C7 3.55228 7.44772 4 8 4ZM8 14C8.55228 14 9 13.5523 9 13C9 12.4477 8.55228 12 8 12C7.44772 12 7 12.4477 7 13C7 13.5523 7.44772 14 8 14ZM14 8C14 8.55228 13.5523 9 13 9C12.4477 9 12 8.55228 12 8C12 7.44772 12.4477 7 13 7C13.5523 7 14 7.44772 14 8ZM4 8C4 8.55228 3.55228 9 3 9C2.44772 9 2 8.55228 2 8C2 7.44772 2.44772 7 3 7C3.55228 7 4 7.44772 4 8Z" fill="currentColor"/>
                        </svg>
                        Analyzing code ownership...
                    </div>
                </div>
            </div>
        `;
    }

    showResults(fullCoverageOwners, combinedSets, approvedReviewers) {
        console.log('Showing results with approvals:', { 
            fullCoverageOwners, 
            combinedSets, 
            approvedReviewers: Array.from(approvedReviewers)
        });
        const contentArea = document.getElementById('code-owners-content');
        if (!contentArea) {
            console.error('Could not find content area to update');
            return;
        }

        const createOwnerElement = (owner) => {
            const isApproved = approvedReviewers.has(owner);
            console.log(`Owner ${owner} approved status:`, isApproved);
            const username = owner.substring(1); // Remove @ symbol
            return `
                <li>
                    <img src="https://github.com/${username}.png" alt="${username}" 
                         width="20" height="20" class="avatar" />
                    <a href="https://github.com/${username}" class="Link--primary">${owner}</a>
                    ${isApproved ? '<span class="color-fg-success">✓</span>' : ''}
                </li>`;
        };

        const createCombinedSetElement = (owners) => {
            return `<span class="combined-set">` + owners.map(owner => {
                const isApproved = approvedReviewers.has(owner);
                const username = owner.substring(1); // Remove @ symbol
                console.log(`Combined set owner ${owner} approved status:`, isApproved);
                return `
                    <span class="d-inline-flex flex-items-center">
                        <img src="https://github.com/${username}.png" alt="${username}" 
                             width="20" height="20" class="avatar mr-1" />
                        <a href="https://github.com/${username}" class="Link--primary">${owner}</a>
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

        // Add this to your showResults method after creating the UI
        contentArea.querySelectorAll('.tooltip-container').forEach(container => {
            const tooltip = container.querySelector('.tooltip');
            
            container.addEventListener('mouseenter', (e) => {
                const rect = container.getBoundingClientRect();
                tooltip.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
                tooltip.style.left = (rect.left + rect.width/2) + 'px';
            });
        });
    }

    async updateUI() {
        console.log('Updating UI...');
        const contentArea = document.getElementById('code-owners-content');
        this.showLoading(contentArea);

        try {
            // Get approved reviewers
            const approvedReviewers = await this.getApprovedReviewers();
            
            // Analyze ownership
            const { fullCoverageOwners, combinedSets } = this.analyzeOwnership();
            
            // Update UI with results
            this.showResults(fullCoverageOwners, combinedSets, approvedReviewers);
        } catch (error) {
            console.error('Error updating UI:', error);
            if (contentArea) {
                contentArea.innerHTML = `<div class="error-message">Error analyzing code owners: ${error.message}</div>`;
            }
        }
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

new MutationObserver(async () => {
    const url = location.href;
    const urlWithoutFragment = url.split('#')[0];
    
    // Only consider it a navigation if the base URL changes (not just the fragment)
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
}).observe(document, { subtree: true, childList: true });

// Also handle Turbo navigation events
document.addEventListener('turbo:render', async () => {
    const url = location.href;
    const urlWithoutFragment = url.split('#')[0];
    
    // Only reinitialize if the base URL has changed
    if (urlWithoutFragment !== lastUrlWithoutFragment) {
        lastUrlWithoutFragment = urlWithoutFragment;
        
        if (url.includes('/files')) {
            // Wait for GitHub's content to load
            await new Promise(resolve => setTimeout(resolve, 1000));
            initializeAnalyzer(); // Will check enabled state internally
        } else {
            removeUI();
        }
    }
});

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