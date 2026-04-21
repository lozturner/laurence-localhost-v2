const fs = require('fs');
const path = require('path');

// Strip common markdown syntax so descriptions render as plain text
function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')        // ![alt](url) → remove images
    .replace(/`{1,3}[^`]*`{1,3}/g, m => m.replace(/`/g, '').trim())  // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')               // *italic* → italic
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')       // __text__ → text
    .replace(/#+\s+/g, '')                        // ## heading → heading
    .replace(/>\s+/g, '')                         // > blockquote → text
    .replace(/[-*+]\s+/g, '')                     // list bullets → remove
    .replace(/\s{2,}/g, ' ')                      // collapse whitespace
    .trim();
}

function generateDescription(project) {
  // Already has a description from package.json
  if (project.description) return project.description;

  // Try README
  if (project.hasReadme) {
    try {
      const readme = fs.readFileSync(path.join(project.path, 'README.md'), 'utf8');
      const lines = readme.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
      if (lines.length > 0) {
        const firstPara = stripMarkdown(lines[0].trim());
        if (firstPara.length > 10) {
          return firstPara.length > 120 ? firstPara.slice(0, 117) + '...' : firstPara;
        }
      }
    } catch {}
  }

  // Build description from framework + notable deps
  const parts = [project.framework, 'project'];
  if (project.packageJson) {
    const deps = { ...project.packageJson.dependencies, ...project.packageJson.devDependencies };
    const notable = [];
    if (deps['@prisma/client'] || deps['prisma']) notable.push('Prisma ORM');
    if (deps['next-auth'] || deps['@auth/core']) notable.push('authentication');
    if (deps['three']) notable.push('3D visualization');
    if (deps['framer-motion']) notable.push('animations');
    if (deps['reactflow'] || deps['@xyflow/react']) notable.push('flow diagrams');
    if (deps['socket.io']) notable.push('real-time');
    if (deps['mongoose'] || deps['mongodb']) notable.push('MongoDB');
    if (deps['pg'] || deps['postgres']) notable.push('PostgreSQL');
    if (deps['@anthropic-ai/sdk']) notable.push('Claude AI');
    if (deps['openai']) notable.push('OpenAI');
    if (deps['puppeteer']) notable.push('browser automation');
    if (deps['electron']) notable.push('desktop app');
    if (notable.length > 0) {
      return `${project.framework} project with ${notable.join(', ')}`;
    }
  }

  // Python project description from main file
  if (project.pythonProject && project.entryFile) {
    try {
      const content = fs.readFileSync(path.join(project.path, project.entryFile), 'utf8');
      // Look for docstring
      const docMatch = content.match(/^"""(.*?)"""/s) || content.match(/^'''(.*?)'''/s);
      if (docMatch) {
        const doc = docMatch[1].trim().split('\n')[0];
        if (doc.length > 10) return doc.length > 120 ? doc.slice(0, 117) + '...' : doc;
      }
      // Look for top comment
      const commentMatch = content.match(/^#\s*(.+)/m);
      if (commentMatch && commentMatch[1].length > 10) {
        return commentMatch[1].trim();
      }
    } catch {}
  }

  // Docker compose description
  if (project.dockerCompose) {
    return `${project.framework} with Docker Compose multi-service stack`;
  }

  // Folder name based fallback
  return `${project.framework} project in ${path.basename(project.path)}`;
}

function enrichDescriptions(projects) {
  for (const project of projects) {
    if (!project.description) {
      project.description = generateDescription(project);
    }
  }
  return projects;
}

module.exports = { enrichDescriptions, generateDescription };
