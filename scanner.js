const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCAN_ROOT = 'C:\\Users\\123';
// After 2026-04-17 migration: most Desktop projects moved to K:\Projects
// Desktop still has a few stragglers (in-use at time of migration)
const K_PROJECTS = 'K:\\Projects';
const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', '.git', 'AppData',
  'OneDrive', '.cache', '.npm', '.nuget', 'venv', '.venv',
  '__pycache__', '.tox', 'egg-info', 'Contacts', 'Favorites',
  'Links', 'Music', 'Pictures', 'Saved Games', 'Searches',
  'Videos', '3D Objects', 'PrintHood', 'SendTo', 'Templates',
  'Start Menu', 'Recent', 'NetHood', 'Cookies', 'Local Settings',
  'Application Data'
]);

const SPECIAL_PATHS = [
  { path: path.join(SCAN_ROOT, '.node-red'), type: 'node-red' },
  { path: 'C:\\xampp', type: 'xampp' },
];

function makeId(projectPath) {
  return crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 12);
}

function titleCase(str) {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function detectFramework(packageJson) {
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const tags = [];

  if (deps['next']) tags.push('Next.js');
  if (deps['electron']) tags.push('Electron');
  if (deps['vite']) tags.push('Vite');
  if (deps['react-scripts']) tags.push('Create React App');
  if (deps['express'] && !deps['next']) tags.push('Express');
  if (deps['react'] && !deps['next'] && !deps['react-scripts'] && !deps['vite']) tags.push('React');
  if (deps['three']) tags.push('Three.js');
  if (deps['@prisma/client'] || deps['prisma']) tags.push('Prisma');
  if (deps['tailwindcss'] || deps['@tailwindcss/postcss']) tags.push('Tailwind');
  if (deps['pywebview']) tags.push('pywebview');
  if (deps['flask']) tags.push('Flask');
  if (deps['django']) tags.push('Django');

  return tags.length ? tags.join(' + ') : 'Node.js';
}

function detectPythonFramework(projectPath) {
  const tags = ['Python'];
  try {
    const reqPath = path.join(projectPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const reqs = fs.readFileSync(reqPath, 'utf8').toLowerCase();
      if (reqs.includes('flask')) tags.push('Flask');
      if (reqs.includes('django')) tags.push('Django');
      if (reqs.includes('pywebview')) tags.push('pywebview');
      if (reqs.includes('fastapi')) tags.push('FastAPI');
    }
  } catch {}
  try {
    const setupPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(setupPath)) {
      const setup = fs.readFileSync(setupPath, 'utf8').toLowerCase();
      if (setup.includes('flask')) tags.push('Flask');
      if (setup.includes('django')) tags.push('Django');
    }
  } catch {}
  return [...new Set(tags)].join(' + ');
}

function getStartCommand(projectPath, framework, packageJson) {
  if (packageJson) {
    const scripts = packageJson.scripts || {};
    if (scripts.dev) return 'npm run dev';
    if (scripts.start) return 'npm start';
    if (scripts.serve) return 'npm run serve';
  }
  if (framework.includes('Django')) return 'python manage.py runserver';
  if (framework.includes('Flask')) return 'python app.py';
  if (framework.includes('Python')) {
    const pyFiles = ['app.py', 'main.py', 'server.py', 'run.py'];
    for (const f of pyFiles) {
      if (fs.existsSync(path.join(projectPath, f))) return `python ${f}`;
    }
  }
  return null;
}

// Read .claude/launch.json in a dir; returns [] if missing/invalid
function readLaunchConfigs(dirPath) {
  try {
    const lp = path.join(dirPath, '.claude', 'launch.json');
    if (fs.existsSync(lp)) {
      const d = JSON.parse(fs.readFileSync(lp, 'utf8'));
      return Array.isArray(d.configurations) ? d.configurations : [];
    }
  } catch {}
  return [];
}

// Build a launch-config based sub-project (for multi-app directories like "laurence bring")
function buildLaunchConfigProject(dirPath, cfg, parentName) {
  const cfgId = makeId(dirPath + '::' + cfg.name);
  // Build start command from runtime + args
  let startCommand = null;
  if (cfg.runtimeExecutable && cfg.runtimeArgs) {
    const exe = path.basename(cfg.runtimeExecutable).replace('.exe', '');
    const args = cfg.runtimeArgs.join(' ');
    startCommand = `${exe} ${args}`;
  }
  // Framework guess from executable/args
  let framework = 'Static HTML';
  const exeName = (cfg.runtimeExecutable || '').toLowerCase();
  const argsStr = (cfg.runtimeArgs || []).join(' ').toLowerCase();
  if (exeName.includes('python')) {
    if (argsStr.includes('flask') || argsStr.includes('app.py')) framework = 'Flask';
    else if (argsStr.includes('http.server')) framework = 'Python';
    else framework = 'Python';
  } else if (exeName.includes('node') || argsStr.includes('node')) {
    framework = 'Express';
  } else if (argsStr.includes('vite')) {
    framework = 'Vite';
  } else if (argsStr.includes('npm') && argsStr.includes('start')) {
    framework = 'Node.js';
  } else if (argsStr.includes('http-server') || argsStr.includes('serve')) {
    framework = 'Static HTML';
  }

  return {
    id: cfgId,
    name: titleCase(cfg.name),
    path: dirPath,
    framework,
    ports: cfg.port ? [cfg.port] : [],
    portSources: cfg.port ? { [cfg.port]: '.claude/launch.json' } : {},
    description: `${framework} app — :${cfg.port || '?'}`,
    status: 'stopped',
    hasReadme: false,
    packageJson: null,
    entryFile: null,
    electronApp: false,
    pythonProject: exeName.includes('python'),
    startCommand,
    launchUrl: cfg.url || (cfg.port ? `http://localhost:${cfg.port}` : null),
    dockerCompose: false,
    isSubConfig: true,
  };
}

function scanDirectory(dirPath, depth = 0, maxDepth = 1, isRoot = false) {
  const projects = [];
  if (depth > maxDepth) return projects;

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return projects;
  }

  // Check if this directory IS a project (but skip the scan root itself)
  if (!isRoot) {
    const launchConfigs = readLaunchConfigs(dirPath);

    // Multi-app directory pattern: has launch.json with multiple configs,
    // no root package.json, AND all configs run locally (not referencing external absolute paths).
    // This distinguishes "laurence bring" (multi-app) from Desktop (global launcher registry).
    const hasRootPkg = fs.existsSync(path.join(dirPath, 'package.json'));
    // Global launcher = any config has absolute path as a DIRECT arg (not after a flag like --directory, --prefix)
    // This distinguishes "Desktop" (points to completely separate projects) from
    // "laurence bring" (uses --directory to point to sibling content folders)
    const CONTENT_FLAGS = new Set(['--directory', '-d', '--prefix', '--cwd', '--root']);
    const isGlobalLauncher = launchConfigs.some(cfg => {
      const args = cfg.runtimeArgs || [];
      return args.some((arg, i) => {
        const prevArg = args[i - 1] || '';
        if (CONTENT_FLAGS.has(prevArg)) return false; // path after a content flag is OK
        const normDir = dirPath.toLowerCase().replace(/\//g, '\\').replace(/\\/g, '\\');
        return (arg.match(/^[A-Z]:\\/i) || arg.startsWith('/c/')) &&
               !arg.toLowerCase().replace(/\//g, '\\').startsWith(normDir);
      });
    });
    if (launchConfigs.length > 1 && !hasRootPkg && !isGlobalLauncher) {
      // Expand into individual project cards
      for (const cfg of launchConfigs) {
        projects.push(buildLaunchConfigProject(dirPath, cfg, path.basename(dirPath)));
      }
      return projects;
    }

    const project = identifyProject(dirPath);
    if (project) {
      // Attach launchUrl from launch.json if present
      if (launchConfigs.length === 1 && launchConfigs[0].url) {
        project.launchUrl = launchConfigs[0].url;
      }
      projects.push(project);
      return projects; // Don't recurse into identified projects
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.node-red') continue;

    const subPath = path.join(dirPath, entry.name);
    projects.push(...scanDirectory(subPath, depth + 1, maxDepth));
  }

  return projects;
}

function identifyProject(dirPath) {
  // Check for package.json
  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const framework = detectFramework(pkg);
      const name = pkg.name ? titleCase(pkg.name) : path.basename(dirPath);
      return {
        id: makeId(dirPath),
        name,
        path: dirPath,
        framework,
        ports: [],
        portSources: {},
        description: pkg.description || null,
        status: 'stopped',
        hasReadme: fs.existsSync(path.join(dirPath, 'README.md')),
        packageJson: pkg,
        entryFile: findEntryFile(dirPath, pkg),
        electronApp: framework.includes('Electron'),
        pythonProject: false,
        startCommand: getStartCommand(dirPath, framework, pkg),
        launchUrl: null,
        dockerCompose: fs.existsSync(path.join(dirPath, 'docker-compose.yml')),
      };
    } catch {}
  }

  // Check for Python projects
  const isPython = fs.existsSync(path.join(dirPath, 'requirements.txt'))
    || fs.existsSync(path.join(dirPath, 'manage.py'))
    || fs.existsSync(path.join(dirPath, 'pyproject.toml'))
    || fs.existsSync(path.join(dirPath, 'setup.py'));

  if (isPython) {
    const framework = detectPythonFramework(dirPath);
    return {
      id: makeId(dirPath),
      name: titleCase(path.basename(dirPath)),
      path: dirPath,
      framework,
      ports: [],
      portSources: {},
      description: null,
      status: 'stopped',
      hasReadme: fs.existsSync(path.join(dirPath, 'README.md')),
      packageJson: null,
      entryFile: findPythonEntry(dirPath),
      electronApp: false,
      pythonProject: true,
      startCommand: getStartCommand(dirPath, framework, null),
      dockerCompose: fs.existsSync(path.join(dirPath, 'docker-compose.yml')),
    };
  }

  // Check for docker-compose only projects
  if (fs.existsSync(path.join(dirPath, 'docker-compose.yml'))) {
    return {
      id: makeId(dirPath),
      name: titleCase(path.basename(dirPath)),
      path: dirPath,
      framework: 'Docker Compose',
      ports: [],
      portSources: {},
      description: null,
      status: 'stopped',
      hasReadme: fs.existsSync(path.join(dirPath, 'README.md')),
      packageJson: null,
      entryFile: null,
      electronApp: false,
      pythonProject: false,
      startCommand: 'docker compose up',
      dockerCompose: true,
    };
  }

  // Check for static HTML sites (index.html without package.json)
  if (fs.existsSync(path.join(dirPath, 'index.html')) && !fs.existsSync(pkgPath)) {
    const hasCSS = fs.existsSync(path.join(dirPath, 'style.css')) || fs.existsSync(path.join(dirPath, 'styles.css'));
    const hasJS = fs.existsSync(path.join(dirPath, 'app.js')) || fs.existsSync(path.join(dirPath, 'script.js')) || fs.existsSync(path.join(dirPath, 'main.js'));
    if (hasCSS || hasJS) {
      return {
        id: makeId(dirPath),
        name: titleCase(path.basename(dirPath)),
        path: dirPath,
        framework: 'Static HTML',
        ports: [],
        portSources: {},
        description: null,
        status: 'stopped',
        hasReadme: fs.existsSync(path.join(dirPath, 'README.md')),
        packageJson: null,
        entryFile: 'index.html',
        electronApp: false,
        pythonProject: false,
        startCommand: null,
        dockerCompose: false,
      };
    }
  }

  return null;
}

function findEntryFile(dirPath, pkg) {
  if (pkg.main) return pkg.main;
  const candidates = ['index.js', 'server.js', 'app.js', 'src/index.js', 'src/App.js', 'src/main.js', 'src/main.tsx'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(dirPath, c))) return c;
  }
  return null;
}

function findPythonEntry(dirPath) {
  const candidates = ['app.py', 'main.py', 'server.py', 'run.py', 'manage.py'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(dirPath, c))) return c;
  }
  return null;
}

function scanSpecialPaths() {
  const projects = [];

  // Node-RED
  const nodeRedPath = path.join(SCAN_ROOT, '.node-red');
  if (fs.existsSync(nodeRedPath)) {
    projects.push({
      id: makeId(nodeRedPath),
      name: 'Node-RED',
      path: nodeRedPath,
      framework: 'Node-RED',
      ports: [1880],
      portSources: { 1880: 'Node-RED default' },
      description: 'Flow-based automation and IoT platform',
      status: 'stopped',
      hasReadme: false,
      packageJson: null,
      entryFile: null,
      electronApp: false,
      pythonProject: false,
      startCommand: 'node-red',
      dockerCompose: false,
    });
  }

  // XAMPP
  const xamppPath = 'C:\\xampp';
  if (fs.existsSync(xamppPath)) {
    projects.push({
      id: makeId(xamppPath),
      name: 'XAMPP',
      path: xamppPath,
      framework: 'XAMPP (Apache + MySQL)',
      ports: [80, 443, 3306],
      portSources: { 80: 'Apache HTTP', 443: 'Apache HTTPS', 3306: 'MySQL' },
      description: 'Apache + MySQL + PHP + Perl development stack',
      status: 'stopped',
      hasReadme: false,
      packageJson: null,
      entryFile: null,
      electronApp: false,
      pythonProject: false,
      startCommand: null,
      dockerCompose: false,
    });
  }

  return projects;
}

async function scan() {
  const projects = [];

  // Scan main user directory (depth 2 to catch top-level project dirs)
  projects.push(...scanDirectory(SCAN_ROOT, 0, 2, true));

  // Scan K:\Projects — post-migration home for all Desktop projects (2026-04-17)
  if (fs.existsSync(K_PROJECTS)) {
    projects.push(...scanDirectory(K_PROJECTS, 0, 1, true));
  }

  // Scan Desktop for stragglers that couldn't be moved during migration (in-use at the time)
  // These will be deduped if they've since been moved to K:\Projects
  const desktopPath = path.join(SCAN_ROOT, 'Desktop');
  if (fs.existsSync(desktopPath)) {
    projects.push(...scanDirectory(desktopPath, 0, 2));
  }

  // Scan known nested paths
  const nestedPaths = [
    path.join(SCAN_ROOT, 'Laurence Lenz', 'laurence-lens'),
  ];
  for (const np of nestedPaths) {
    if (fs.existsSync(np)) {
      const project = identifyProject(np);
      if (project && !projects.find(p => p.path === np)) {
        projects.push(project);
      }
    }
  }

  // Add special paths (Node-RED, XAMPP)
  const specialProjects = scanSpecialPaths();
  // Remove any duplicates that were already found by the directory scanner
  const existingPaths = new Set(projects.map(p => path.resolve(p.path)));
  for (const sp of specialProjects) {
    if (!existingPaths.has(path.resolve(sp.path))) {
      projects.push(sp);
    } else {
      // Replace the generic version with the special version (better metadata)
      const idx = projects.findIndex(p => path.resolve(p.path) === path.resolve(sp.path));
      if (idx !== -1) projects[idx] = sp;
    }
  }

  // Deduplicate by ID (sub-configs share path but have unique IDs) and exclude self
  const selfPath = path.resolve(__dirname);
  const seenIds = new Set();
  const seenPaths = new Set();
  return projects.filter(p => {
    if (seenIds.has(p.id)) return false;
    if (path.resolve(p.path) === selfPath) return false;
    // For regular projects, also dedup by path to avoid scanning the same folder twice
    // Sub-config projects are exempt from path-dedup since they intentionally share a path
    if (!p.isSubConfig) {
      if (seenPaths.has(p.path)) return false;
      seenPaths.add(p.path);
    }
    seenIds.add(p.id);
    return true;
  });
}

module.exports = { scan };
