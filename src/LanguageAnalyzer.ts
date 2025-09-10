import * as vscode from 'vscode';
import { typescriptLanguageHandler } from './tsAnalyzer';
import { parsePythonWithAST } from './pythonAnalyzer';

export async function parseCode(editor: typeof vscode.window.activeTextEditor): Promise<{
    mermaidCode: string, 
    lineMapping: string, 
    nodeSequence: string,
    nodeMeta: string
}> {

    let parseResult : Promise<{
        mermaidCode  : string,
        lineMapping  : string,
        nodeSequence : string,
        nodeMeta     : string
    }> = Promise.resolve({
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
            parseResult = parsePythonWithAST(fullCode);
            break;
        case 'typescript':
        case 'javascript':
        case 'typescriptreact':
        case 'javascriptreact':
            parseResult = typescriptLanguageHandler(fullCode); 
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

    return parseResult;
}

