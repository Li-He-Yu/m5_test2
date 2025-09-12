import * as vscode from 'vscode';
import { typescriptLanguageHandler } from './tsAnalyzer';
import { parsePythonWithAST } from './pythonAnalyzer';

export interface ParseResult {
    mermaidCode: string;        // same shape your Python path returns
    lineMapping: string;        // JSON string map: { "12": ["node7", ...], ... }
    nodeSequence: string;       // JSON string array: ["Start","node1",...,"End"]
    nodeMeta: string;           // JSON string of NodeMeta
}

export async function parseCode(editor: typeof vscode.window.activeTextEditor): Promise<ParseResult> {

    let Result : Promise<ParseResult> = Promise.resolve({
        mermaidCode  : "",
        lineMapping  : "",
        nodeSequence : "",
        nodeMeta     : ""
    });

    if(!editor){
        console.error('No active file');
        vscode.window.showErrorMessage('No active file');
        throw new Error(
            'No active file'
        );
    }

    const document = editor.document;
    const fullCode = document.getText();
    switch (document.languageId){
        case 'python':
            Result = parsePythonWithAST(fullCode);
            break;
        case 'typescript':
        case 'javascript':
        case 'typescriptreact':
        case 'javascriptreact':
            Result = typescriptLanguageHandler(fullCode); 
            break;
        case 'c':
        case 'cpp':
        case 'java':
            console.error('Not supported language');
            vscode.window.showErrorMessage('Not supported language');
            break;
            
        // may not support
        case 'html':
        case 'css':
        case 'json':
        default:
            console.error('Not supported language');
            vscode.window.showErrorMessage('Not supported language');
            break;
    }

    return Result;
}

