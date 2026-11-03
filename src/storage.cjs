'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

class TemporaryStorage {
  constructor(root) { this.root = path.resolve(root); }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await fs.realpath(this.root);
  }
  contains(file) {
    const relative = path.relative(this.root, path.resolve(file));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  async create() {
    await this.initialize();
    return fs.mkdtemp(path.join(this.root, 'transfer-'));
  }
  async removeJob(directory) {
    if (path.dirname(directory) !== this.root || !/^transfer-[a-zA-Z0-9]+$/.test(path.basename(directory))) {
      throw new Error('La carpeta no pertenece a los temporales de ClipDrop.');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  async clean() {
    for (const entry of await this.entries()) {
      if (/^transfer-[a-zA-Z0-9]+$/.test(entry.name)) await this.removeJob(path.join(this.root, entry.name));
    }
  }
  async entries() {
    try { return await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async bytes() {
    async function size(directory) {
      let total = 0;
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await size(file);
        else if (entry.isFile()) {
          try { total += (await fs.stat(file)).size; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      return total;
    }
    return size(this.root);
  }
}
module.exports = { TemporaryStorage };
