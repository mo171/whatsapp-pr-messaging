const fs = require('fs');
const path = require('path');

// ── Patch 1: Media ID collision fix in Injected/Utils.js ───────────────────────
const utilsFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

if (fs.existsSync(utilsFile)) {
    let content = fs.readFileSync(utilsFile, 'utf8');
    if (!content.includes('delete message.__x_id;')) {
        const needleLF = '            ...extraOptions,\n        };';
        const replacementLF = `            ...extraOptions,\n        };\n\n        // Fix: MediaData contains private __x_id which collides with Msg ID\n        // and throws "Data passed to getter must include an id property"\n        delete message.__x_id;\n        message.id = newMsgKey;`;

        const needleCRLF = '            ...extraOptions,\r\n        };';
        const replacementCRLF = `            ...extraOptions,\r\n        };\r\n\r\n        // Fix: MediaData contains private __x_id which collides with Msg ID\r\n        // and throws "Data passed to getter must include an id property"\n        delete message.__x_id;\n        message.id = newMsgKey;`;

        if (content.includes(needleLF)) {
            content = content.replace(needleLF, replacementLF);
            fs.writeFileSync(utilsFile, content, 'utf8');
            console.log('✅ [patch-wwebjs] Successfully patched Utils.js for media send memoize error.');
        } else if (content.includes(needleCRLF)) {
            content = content.replace(needleCRLF, replacementCRLF);
            fs.writeFileSync(utilsFile, content, 'utf8');
            console.log('✅ [patch-wwebjs] Successfully patched Utils.js for media send memoize error.');
        } else {
            console.warn('⚠️ [patch-wwebjs] Could not find insertion target in Utils.js.');
        }
    }
}

// ── Patch 2: Windows EBUSY unlink lock fix in LocalAuth.js ────────────────────
const localAuthFile = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'authStrategies', 'LocalAuth.js');

if (fs.existsSync(localAuthFile)) {
    let content = fs.readFileSync(localAuthFile, 'utf8');
    if (!content.includes('EBUSY')) {
        const badCatch = `.catch((e) => {\n                    throw new Error(e);\n                });`;
        const badCatchCRLF = `.catch((e) => {\r\n                    throw new Error(e);\r\n                });`;
        const fixedCatch = `.catch((e) => {\n                    if (process.platform === 'win32' || String(e).includes('EBUSY')) {\n                        console.warn('⚠️ [LocalAuth] Session file locked during logout cleanup on Windows. Skipping rm.');\n                    } else {\n                        throw new Error(e);\n                    }\n                });`;
        const fixedCatchCRLF = `.catch((e) => {\r\n                    if (process.platform === 'win32' || String(e).includes('EBUSY')) {\r\n                        console.warn('⚠️ [LocalAuth] Session file locked during logout cleanup on Windows. Skipping rm.');\r\n                    } else {\r\n                        throw new Error(e);\r\n                    }\r\n                });`;

        if (content.includes(badCatch)) {
            content = content.replace(badCatch, fixedCatch);
            fs.writeFileSync(localAuthFile, content, 'utf8');
            console.log('✅ [patch-wwebjs] Successfully patched LocalAuth.js for Windows EBUSY logout error.');
        } else if (content.includes(badCatchCRLF)) {
            content = content.replace(badCatchCRLF, fixedCatchCRLF);
            fs.writeFileSync(localAuthFile, content, 'utf8');
            console.log('✅ [patch-wwebjs] Successfully patched LocalAuth.js for Windows EBUSY logout error.');
        }
    }
}
