
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let parse: any;

try {
  const ptr = require('path-to-regexp');
  parse = ptr.parse;
} catch (e) {
  try {
     const ptr = require('path-to-regexp/dist/index.js');
     parse = ptr.parse;
  } catch (e2) {
    console.error("Could not load path-to-regexp");
    process.exit(1);
  }
}

const routesDir = path.join(process.cwd(), 'server', 'routes');
const indexFile = path.join(process.cwd(), 'server', 'index.ts');

async function checkFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Match router.METHOD("path", ...) or app.METHOD("path", ...)
  // Regex to capture the path string
  const regex = /(?:router|app)\.(?:get|post|put|delete|patch|use)\s*\(\s*(['"`])(.*?)\1/g;
  
  let match;
  while ((match = regex.exec(content)) !== null) {
    const routePath = match[2];
    const quote = match[1];
    
    // Skip if it looks like a variable (though our regex expects quotes, so it should be a string literal)
    // We captured the content inside quotes.
    
    try {
      // In path-to-regexp v8, parse is named export
      parse(routePath);
    } catch (e: any) {
      console.error(`❌ Error in file ${path.basename(filePath)}:`);
      console.error(`   Path: ${quote}${routePath}${quote}`);
      console.error(`   Error: ${e.message}`);
      // console.error(e);
    }
  }
}

async function main() {
  console.log("Checking routes for path-to-regexp errors...");
  
  try {
    parse("*");
    console.log("parse('*') succeeded");
  } catch (e: any) {
    console.log(`Confirmed: parse('*') fails with: ${e.message}`);
  }

  const allFiles = getAllFiles(path.join(process.cwd(), 'server'));
  console.log(`Found ${allFiles.length} files in server/`);

  for (const file of allFiles) {
    if (file.endsWith('.ts')) {
      await checkFile(file);
    }
  }
  
  console.log("Done checking.");
}

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(function(file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      if (file !== 'node_modules' && file !== '__tests__') {
        arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
      }
    } else {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
}

main().catch(console.error);
