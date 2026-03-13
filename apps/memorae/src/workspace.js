/**
 * File Workspace module for Jarvis
 * Per-tenant isolated file system for notes, documents, projects
 */
const fs = require('fs');
const path = require('path');

const WORKSPACES_DIR = path.join(__dirname, '..', 'data', 'workspaces');

/**
 * Get the workspace path for a tenant
 */
function getWorkspacePath(tenantId) {
  const dir = path.join(WORKSPACES_DIR, String(tenantId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Sanitize a file path to prevent directory traversal
 */
function sanitizePath(tenantId, filePath) {
  const workspace = getWorkspacePath(tenantId);
  // Remove leading slashes and ..
  const clean = filePath.replace(/^[\/\\]+/, '').replace(/\.\./g, '');
  const full = path.resolve(workspace, clean);
  
  // Ensure it's within the workspace
  if (!full.startsWith(workspace)) {
    return null;
  }
  return full;
}

/**
 * Create or overwrite a file
 */
function writeFile(tenantId, filePath, content) {
  const fullPath = sanitizePath(tenantId, filePath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
    return { success: true, path: filePath, size: content.length };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Read a file
 */
function readFile(tenantId, filePath) {
  const fullPath = sanitizePath(tenantId, filePath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    if (!fs.existsSync(fullPath)) {
      return { error: 'File not found' };
    }
    const stats = fs.statSync(fullPath);
    if (stats.size > 50000) {
      // Read first 50KB
      const content = fs.readFileSync(fullPath, 'utf8').substring(0, 50000);
      return { content, truncated: true, size: stats.size };
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    return { content, size: stats.size };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Append to a file
 */
function appendFile(tenantId, filePath, content) {
  const fullPath = sanitizePath(tenantId, filePath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(fullPath, content, 'utf8');
    return { success: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Delete a file
 */
function deleteFile(tenantId, filePath) {
  const fullPath = sanitizePath(tenantId, filePath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    if (!fs.existsSync(fullPath)) {
      return { error: 'File not found' };
    }
    fs.unlinkSync(fullPath);
    return { success: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * List files in a directory
 */
function listFiles(tenantId, dirPath = '/') {
  const fullPath = sanitizePath(tenantId, dirPath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    if (!fs.existsSync(fullPath)) {
      return { files: [], path: dirPath };
    }
    
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const files = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? fs.statSync(path.join(fullPath, e.name)).size : null,
    }));
    
    return { files, path: dirPath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Create a directory
 */
function createDir(tenantId, dirPath) {
  const fullPath = sanitizePath(tenantId, dirPath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    fs.mkdirSync(fullPath, { recursive: true });
    return { success: true, path: dirPath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Edit a file (find and replace)
 */
function editFile(tenantId, filePath, oldText, newText) {
  const fullPath = sanitizePath(tenantId, filePath);
  if (!fullPath) return { error: 'Invalid path' };
  
  try {
    if (!fs.existsSync(fullPath)) {
      return { error: 'File not found' };
    }
    let content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes(oldText)) {
      return { error: 'Text not found in file' };
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(fullPath, content, 'utf8');
    return { success: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get workspace usage stats
 */
function getWorkspaceStats(tenantId) {
  const workspace = getWorkspacePath(tenantId);
  
  let totalFiles = 0;
  let totalSize = 0;
  
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else {
          totalFiles++;
          totalSize += fs.statSync(full).size;
        }
      }
    } catch (e) { /* ignore */ }
  }
  
  walk(workspace);
  return { totalFiles, totalSize, totalSizeHuman: formatBytes(totalSize) };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

module.exports = { 
  writeFile, readFile, appendFile, deleteFile, 
  listFiles, createDir, editFile, getWorkspaceStats,
  getWorkspacePath 
};
