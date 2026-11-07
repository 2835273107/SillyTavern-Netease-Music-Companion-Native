import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

function loadPromptModule(settings) {
    const start = source.indexOf('const PROMPT_TEMPLATE_FORMAT');
    const end = source.indexOf('function renderPromptGroupOptions');
    assert.ok(start > 0 && end > start, 'prompt module markers not found');
    const context = {
        CANDIDATE_GUARD: 'guard',
        EXTENSION_KEY: 'k',
        extension_settings: { k: settings },
        saveSettingsDebounced() {},
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}
        ${source.slice(source.indexOf('function uniquePromptGroupName'), source.indexOf('function downloadJson'))}
        this.api = { PROMPT_DEFINITIONS, normalizePromptSettings, renderPrompt, sanitizePromptOverrides, addPromptGroup };`, context);
    context.api.normalizePromptSettings();
    return context.api;
}

test('every renderPrompt call uses a defined template and declared variables', () => {
    const { PROMPT_DEFINITIONS } = loadPromptModule({});
    const definitions = new Map(PROMPT_DEFINITIONS.map(item => [item.key, item]));
    const calls = [...source.matchAll(/renderPrompt\('(\w+)'(?:,\s*\{([\s\S]*?)\})?\)/g)];
    assert.ok(calls.length >= 10);
    for (const [, key, args = ''] of calls) {
        const definition = definitions.get(key);
        assert.ok(definition, `unknown prompt key ${key}`);
        const passed = [...args.matchAll(/(?:^|,)\s*(\w+)\s*(?=:|,|$)/g)].map(match => match[1]);
        for (const name of passed) {
            assert.ok(name in definition.variables, `${key} receives undeclared variable ${name}`);
        }
        const used = [...definition.template.matchAll(/\{\{(\w+)\}\}/g)]
            .map(match => match[1])
            .filter(name => !['char', 'user'].includes(name));
        for (const name of used) {
            assert.ok(name in definition.variables, `${key} template uses undeclared ${name}`);
        }
    }
});

test('custom groups override defaults and unknown keys are dropped', () => {
    const api = loadPromptModule({
        promptGroups: [{ id: 'mine', name: 'Mine', prompts: { songComment: 'X {{songContext}} {{limit}}', bogus: 'y' } }],
        activePromptGroupId: 'mine',
    });
    assert.equal(api.renderPrompt('songComment', { songContext: 'S', limit: 9 }), 'X S 9');
    assert.match(api.renderPrompt('personaPlan', { jsonShape: '{}' }), /^你是 \{\{char\}\}/);
    assert.deepEqual(Object.keys(api.sanitizePromptOverrides({ bogus: 'y', songComment: '  ' })), []);
    const imported = api.addPromptGroup('Mine', { songComment: 'Z' });
    assert.equal(imported.name, 'Mine (2)');
});