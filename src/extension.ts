import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

interface FlowChartMapping {
    lineToNode: Map<number, string>;
    nodeToLine: Map<string, number[]>;
}

// Global variables to maintain state
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentEditor: vscode.TextEditor | undefined = undefined;
let lineToNodeMap: Map<number, string> = new Map();
let nodeToLineMap: Map<string, number[]> = new Map();

export function activate(context: vscode.ExtensionContext) {
    console.log('Python Flow Chart extension is now active!');

    // Register command to show flow chart
    let disposable = vscode.commands.registerCommand('m5-test2.generate', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'python') {
            vscode.window.showErrorMessage('Please open a Python file first');
            return;
        }

        currentEditor = editor;
        const pythonCode = editor.document.getText();
        
        // Create or reveal webview
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.Two);
        } else {
            currentPanel = vscode.window.createWebviewPanel(
                'pythonFlowChart',
                'Python Flow Chart',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
            }, null, context.subscriptions);
        }

        // Generate flow chart
        try {
            console.log('Generating flow chart...');
            vscode.window.showInformationMessage('Generating flow chart...');
            
            const { svg, mapping } = await generateFlowChart(pythonCode, context.extensionPath);
            console.log('SVG generated, length:', svg.length);
            console.log('Mapping generated:', mapping.lineToNode.size, 'lines,', mapping.nodeToLine.size, 'nodes');
            
            // Log the line mappings for debugging
            console.log('Line to Node mappings:');
            mapping.lineToNode.forEach((nodeId, line) => {
                console.log(`  Line ${line} -> ${nodeId}`);
            });
            
            console.log('Node to Line mappings:');
            mapping.nodeToLine.forEach((lines, nodeId) => {
                console.log(`  ${nodeId} -> Lines: ${lines.join(', ')}`);
            });
            const cleanedSvg = svg.replace(/\r\n/g, '\n').replace(/\\/g, '');


            // Log what's in the SVG
            console.log('Checking SVG for node_1:');
            if (cleanedSvg.includes('node_1')) {
                console.log('node_1 found in SVG');
                // Extract the title element for node_1
                const node1Match = cleanedSvg.match(/<g[^>]*id="node_1"[^>]*>[\s\S]*?<title>([^<]+)<\/title>/);
                if (node1Match) {
                    console.log('node_1 title content:', node1Match[1]);
                }
            } else {
                console.log('node_1 NOT found in SVG');
            }
            
            lineToNodeMap = mapping.lineToNode;
            nodeToLineMap = mapping.nodeToLine;
            
            // Clean and set HTML content
            
            
            // Also log the SVG to check node IDs
            const nodeMatches = cleanedSvg.match(/id="node_\d+"/g);
            if (nodeMatches) {
                console.log('SVG contains nodes:', nodeMatches);
            }
            
            currentPanel.webview.html = getWebviewContent(cleanedSvg);
            
            vscode.window.showInformationMessage('Flow chart generated successfully! Click on code lines to highlight nodes.');
            
            // Handle messages from webview
            currentPanel.webview.onDidReceiveMessage(
                message => {
                    console.log('Received message from webview:', message);
                    switch (message.command) {
                        case 'nodeClicked':
                            highlightCodeLines(message.nodeId);
                            return;
                    }
                },
                undefined,
                context.subscriptions
            );
        } catch (error: any) {
            console.error('Error details:', error);
            vscode.window.showErrorMessage(`Error generating flow chart: ${error.message || error}`);
        }
    });

    // Register cursor change handler
    const selectionHandler = vscode.window.onDidChangeTextEditorSelection(event => {
        if (currentPanel && event.textEditor === currentEditor) {
            const line = event.selections[0].active.line + 1; // VSCode lines are 0-based
            const nodeId = lineToNodeMap.get(line);
            
            console.log(`Cursor at line ${line}, nodeId: ${nodeId}`);
            
            if (nodeId) {
                // Send message to webview to highlight the node
                currentPanel.webview.postMessage({
                    command: 'highlightNode',
                    nodeId: nodeId
                });
                
                // Optional: Show status bar message
                vscode.window.setStatusBarMessage(`Flow chart node: ${nodeId}`, 2000);
            } else {
                // Clear highlight if line has no corresponding node
                currentPanel.webview.postMessage({
                    command: 'clearHighlight'
                });
            }
        }
    });
    
    context.subscriptions.push(selectionHandler);
    context.subscriptions.push(disposable);
}

async function generateFlowChart(pythonCode: string, extensionPath: string): Promise<{svg: string, mapping: FlowChartMapping}> {
    return new Promise((resolve, reject) => {
        const pythonScriptPath = path.join(extensionPath, 'src', 'python', 'ast_to_graphviz.py');
        console.log('Python script path:', pythonScriptPath);
        
        // Get Python path from configuration
        const config = vscode.workspace.getConfiguration('python-flowchart');
        const pythonPath = config.get<string>('pythonPath', 'python');
        console.log('Using Python:', pythonPath);
        
        // Spawn Python process with UTF-8 encoding
        const pythonProcess = spawn(pythonPath, ['-u', pythonScriptPath], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        
        let output = '';
        let error = '';

        pythonProcess.stdout.setEncoding('utf8');
        pythonProcess.stderr.setEncoding('utf8');

        pythonProcess.stdout.on('data', (data) => {
            output += data;
            console.log('Python stdout chunk received, length:', data.length);
        });

        pythonProcess.stderr.on('data', (data) => {
            error += data;
            console.error('Python stderr:', data);
        });

        pythonProcess.on('error', (err) => {
            console.error('Failed to start Python process:', err);
            reject(err);
        });

        pythonProcess.on('close', (code) => {
            console.log('Python process exited with code:', code);
            if (code !== 0) {
                reject(new Error(error || 'Python script failed'));
            } else {
                try {
                    const result = JSON.parse(output);
                    const lineToNodeEntries: [number, string][] = Object.entries(result.lineToNode)
                        .map(([k, v]) => [parseInt(k), v as string]);
                    const nodeToLineEntries: [string, number[]][] = Object.entries(result.nodeToLine)
                        .map(([k, v]) => [k, v as number[]]);
                    
                    resolve({
                        svg: result.svg,
                        mapping: {
                            lineToNode: new Map(lineToNodeEntries),
                            nodeToLine: new Map(nodeToLineEntries)
                        }
                    });
                } catch (e) {
                    console.error('Failed to parse Python output:', e);
                    console.error('Output was:', output);
                    reject(new Error('Failed to parse Python output'));
                }
            }
        });

        // Send Python code to the script with UTF-8 encoding
        pythonProcess.stdin.setDefaultEncoding('utf8');
        pythonProcess.stdin.write(pythonCode);
        pythonProcess.stdin.end();
    });
}

function highlightCodeLines(nodeId: string) {
    if (!currentEditor || !nodeToLineMap.has(nodeId)) return;

    const lines = nodeToLineMap.get(nodeId);
    if (!lines || lines.length === 0) return;

    const startLine = Math.min(...lines) - 1;
    const endLine = Math.max(...lines) - 1;

    const startPos = new vscode.Position(startLine, 0);
    const endPos = new vscode.Position(endLine, currentEditor.document.lineAt(endLine).text.length);
    const selection = new vscode.Selection(startPos, endPos);

    currentEditor.selection = selection;
    currentEditor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
}

function getWebviewContent(svg: string): string {
    // Process SVG to ensure nodes have proper IDs
    let processedSvg = svg;
    
    // First, let's see what the SVG structure looks like
    console.log('Original SVG sample:', svg.substring(0, 1000));
    
    // Find all g elements with class="node" and ensure they have the correct ID
    processedSvg = processedSvg.replace(/<g\s+id="(node_\d+)"\s+class="node">/g, (match, nodeId) => {
        return `<g id="${nodeId}" class="node clickable" data-node-id="${nodeId}">`;
    });
    
    // Also handle the case where class comes before id
    processedSvg = processedSvg.replace(/<g\s+class="node"\s+id="(node_\d+)">/g, (match, nodeId) => {
        return `<g id="${nodeId}" class="node clickable" data-node-id="${nodeId}">`;
    });
    
    // Build HTML content with proper string concatenation
    const htmlContent = `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Python Flow Chart</title>
        <style>
            body {
                margin: 0;
                padding: 20px;
                overflow: auto;
                background-color: white;
                color: #333;
            }
            #graph-container {
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: calc(100vh - 40px);
                background: white;
            }
            svg {
                max-width: 100%;
                height: auto;
                background: white;
                overflow: visible !important;
            }
            .node {
                cursor: pointer;
                transition: opacity 0.3s ease;
            }
            .node:hover {
                opacity: 0.9;
            }
            
            /* Simple glow effect without scaling */
            .node.glow > ellipse,
            .node.glow > polygon,
            .node.glow > path,
            .node.glow > rect {
                stroke: #FF6B00 !important;
                stroke-width: 6px !important;
                filter: drop-shadow(0 0 20px #FF6B00);
                animation: glowPulse 1.5s ease-in-out infinite;
            }
            
            @keyframes glowPulse {
                0%, 100% {
                    stroke-width: 6px;
                    filter: drop-shadow(0 0 20px #FF6B00);
                }
                50% {
                    stroke-width: 8px;
                    filter: drop-shadow(0 0 35px #FF6B00);
                }
            }
            
            /* Debug styles */
            .debug-info {
                position: fixed;
                top: 10px;
                left: 10px;
                background: #f5f5f5;
                border: 1px solid #ddd;
                padding: 15px;
                font-family: Arial, sans-serif;
                font-size: 14px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                border-radius: 4px;
                z-index: 1000;
                text-align: center;
                color: #666;
            }
            
            .status {
                position: fixed;
                bottom: 10px;
                left: 50%;
                transform: translateX(-50%);
                background: #333;
                color: white;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 12px;
                opacity: 0;
                transition: opacity 0.3s;
                z-index: 1000;
            }
            
            .status.show {
                opacity: 1;
            }
        </style>
    </head>
    <body>
        <div class="debug-info">
            <div>Coming soon...</div>
        </div>
        <div id="status" class="status"></div>
        <div id="graph-container">
            ${processedSvg}
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            let currentHighlighted = null;
            
            function showStatus(message) {
                const status = document.getElementById('status');
                status.textContent = message;
                status.classList.add('show');
                setTimeout(() => {
                    status.classList.remove('show');
                }, 2000);
            }
            
            // Wait for DOM to be ready
            document.addEventListener('DOMContentLoaded', function() {
                const nodes = document.querySelectorAll('.node');
                console.log('Found nodes:', nodes.length);
                
                // Debug: Log all node structures
                nodes.forEach((node, index) => {
                    console.log('Node ' + index + ':', node);
                    console.log('  ID:', node.id);
                    const titleElement = node.querySelector('title');
                    console.log('  Title:', titleElement ? titleElement.textContent : 'no title');
                });
                
                // Add click handlers to all nodes
                nodes.forEach(node => {
                    // Get node ID - Graphviz puts the ID in the <title> element
                    let nodeId = null;
                    const titleElement = node.querySelector('title');
                    if (titleElement && titleElement.textContent) {
                        nodeId = titleElement.textContent;
                    }
                    
                    // Fallback to id attribute
                    if (!nodeId) {
                        nodeId = node.id || node.getAttribute('id');
                    }
                    
                    console.log('Processing node with ID:', nodeId);
                    
                    if (nodeId) {
                        // Store the node ID for easy access later
                        node.setAttribute('data-flowchart-node-id', nodeId);
                        
                        node.addEventListener('click', function(e) {
                            e.stopPropagation();
                            console.log('Node clicked:', nodeId);
                            
                            vscode.postMessage({
                                command: 'nodeClicked',
                                nodeId: nodeId
                            });
                            showStatus('Jumped to code line');
                        });
                    }
                    
                    // Add visual feedback
                    node.style.cursor = 'pointer';
                });
            });

            // Handle highlight messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                console.log('Received message:', message);
                
                switch (message.command) {
                    case 'highlightNode':
                        // Remove ALL previous highlights first
                        document.querySelectorAll('.node').forEach(n => {
                            n.classList.remove('glow');
                            n.classList.remove('highlighted');
                            n.classList.remove('highlighted-alt');
                            n.classList.remove('highlighted-subtle');
                        });
                        
                        // Clear currentHighlighted
                        currentHighlighted = null;
                        
                        // Find the node - try multiple methods
                        let node = null;
                        const allNodes = document.querySelectorAll('.node');
                        
                        // Method 1: Direct ID match
                        node = document.getElementById(message.nodeId);
                        
                        // Method 2: Data attribute
                        if (!node) {
                            node = document.querySelector('[data-flowchart-node-id="' + message.nodeId + '"]');
                        }
                        
                        // Method 3: Search by title content
                        if (!node) {
                            for (let n of allNodes) {
                                const title = n.querySelector('title');
                                if (title && title.textContent === message.nodeId) {
                                    node = n;
                                    break;
                                }
                            }
                        }
                        
                        // Method 4: Check if the node has an ID that matches
                        if (!node) {
                            for (let n of allNodes) {
                                if (n.id === message.nodeId || n.getAttribute('id') === message.nodeId) {
                                    node = n;
                                    break;
                                }
                            }
                        }
                        
                        console.log('Looking for node:', message.nodeId);
                        console.log('Found node:', node);
                        
                        if (node) {
                            // Use simple glow effect
                            node.classList.add('glow');
                            currentHighlighted = node;
                            
                            // Scroll into view with some padding
                            node.scrollIntoView({ 
                                behavior: 'smooth', 
                                block: 'center',
                                inline: 'center'
                            });
                            
                            console.log('Successfully highlighted node:', message.nodeId);
                            showStatus('Node highlighted: ' + message.nodeId);
                        } else {
                            console.error('Node not found:', message.nodeId);
                            console.log('Available nodes:');
                            allNodes.forEach((n, i) => {
                                console.log('  Node ' + i + ': id="' + n.id + '", title="' + (n.querySelector('title')?.textContent || '') + '"');
                            });
                            showStatus('Node not found: ' + message.nodeId);
                        }
                        break;
                        
                    case 'clearHighlight':
                        // Clear all highlights
                        document.querySelectorAll('.node').forEach(n => {
                            n.classList.remove('glow');
                            n.classList.remove('highlighted');
                            n.classList.remove('highlighted-alt');
                            n.classList.remove('highlighted-subtle');
                        });
                        currentHighlighted = null;
                        break;
                }
            });
        </script>
    </body>
    </html>`;
    
    return htmlContent;
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
    }
}