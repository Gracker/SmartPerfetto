#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

'use strict';

const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_32 = 0xfeedface;
const MACHO_64 = 0xfeedfacf;
const FAT_32 = 0xcafebabe;
const FAT_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

function numericVersion(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d+){1,2}$/.test(text)) {
    throw new Error(`invalid native compatibility version: ${value}`);
  }
  return text.split('.').map(Number);
}

function compareVersions(left, right) {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function highestVersion(versions) {
  return versions.reduce(
    (highest, candidate) => (
      highest === null || compareVersions(candidate, highest) > 0 ? candidate : highest
    ),
    null,
  );
}

function formatEncodedMacosVersion(encoded) {
  const major = (encoded >>> 16) & 0xffff;
  const minor = (encoded >>> 8) & 0xff;
  const patch = encoded & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
}

function machoMinimumVersionsFromBuffer(buffer) {
  const versions = [];

  function parseThin(offset, size) {
    if (offset < 0 || size < 28 || offset + size > buffer.length) {
      throw new Error('invalid Mach-O slice bounds');
    }
    const magicLE = buffer.readUInt32LE(offset);
    const magicBE = buffer.readUInt32BE(offset);
    let littleEndian;
    let is64Bit;
    if (magicLE === MACHO_32 || magicLE === MACHO_64) {
      littleEndian = true;
      is64Bit = magicLE === MACHO_64;
    } else if (magicBE === MACHO_32 || magicBE === MACHO_64) {
      littleEndian = false;
      is64Bit = magicBE === MACHO_64;
    } else {
      throw new Error('unsupported Mach-O slice magic');
    }

    const headerSize = is64Bit ? 32 : 28;
    const commandCount = readUInt32(buffer, offset + 16, littleEndian);
    const commandBytes = readUInt32(buffer, offset + 20, littleEndian);
    const commandsEnd = offset + headerSize + commandBytes;
    if (commandsEnd > offset + size || commandsEnd > buffer.length) {
      throw new Error('Mach-O load commands exceed slice bounds');
    }

    let commandOffset = offset + headerSize;
    for (let index = 0; index < commandCount; index++) {
      if (commandOffset + 8 > commandsEnd) {
        throw new Error('truncated Mach-O load command');
      }
      const command = readUInt32(buffer, commandOffset, littleEndian);
      const commandSize = readUInt32(buffer, commandOffset + 4, littleEndian);
      if (commandSize < 8 || commandOffset + commandSize > commandsEnd) {
        throw new Error('invalid Mach-O load command size');
      }
      if (command === LC_BUILD_VERSION) {
        if (commandSize < 24) throw new Error('truncated LC_BUILD_VERSION');
        const platform = readUInt32(buffer, commandOffset + 8, littleEndian);
        if (platform !== 1) {
          throw new Error(`Mach-O payload targets platform ${platform}, not macOS`);
        }
        versions.push(formatEncodedMacosVersion(
          readUInt32(buffer, commandOffset + 12, littleEndian),
        ));
      } else if (command === LC_VERSION_MIN_MACOSX) {
        if (commandSize < 16) throw new Error('truncated LC_VERSION_MIN_MACOSX');
        versions.push(formatEncodedMacosVersion(
          readUInt32(buffer, commandOffset + 8, littleEndian),
        ));
      }
      commandOffset += commandSize;
    }
  }

  const magicBE = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  const magicLE = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  if ([MACHO_32, MACHO_64].includes(magicLE) || [MACHO_32, MACHO_64].includes(magicBE)) {
    parseThin(0, buffer.length);
    return versions;
  }

  let littleEndian;
  let is64Bit;
  if (magicBE === FAT_32 || magicBE === FAT_64) {
    littleEndian = false;
    is64Bit = magicBE === FAT_64;
  } else if (magicLE === FAT_32 || magicLE === FAT_64) {
    littleEndian = true;
    is64Bit = magicLE === FAT_64;
  } else {
    return versions;
  }
  const architectureCount = readUInt32(buffer, 4, littleEndian);
  const architectureSize = is64Bit ? 32 : 20;
  let architectureOffset = 8;
  for (let index = 0; index < architectureCount; index++) {
    if (architectureOffset + architectureSize > buffer.length) {
      throw new Error('truncated universal Mach-O header');
    }
    const sliceOffset = is64Bit
      ? Number(littleEndian
        ? buffer.readBigUInt64LE(architectureOffset + 8)
        : buffer.readBigUInt64BE(architectureOffset + 8))
      : readUInt32(buffer, architectureOffset + 8, littleEndian);
    const sliceSize = is64Bit
      ? Number(littleEndian
        ? buffer.readBigUInt64LE(architectureOffset + 16)
        : buffer.readBigUInt64BE(architectureOffset + 16))
      : readUInt32(buffer, architectureOffset + 12, littleEndian);
    parseThin(sliceOffset, sliceSize);
    architectureOffset += architectureSize;
  }
  return versions;
}

function glibcVersionsFromBuffer(buffer) {
  const versions = new Set();
  const text = buffer.toString('latin1');
  for (const match of text.matchAll(/GLIBC_(\d+\.\d+(?:\.\d+)?)/g)) {
    versions.add(match[1]);
  }
  return [...versions];
}

function firstBytes(filePath, length = 4) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkFiles(root) {
  const files = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`native compatibility audit refuses symbolic links: ${candidate}`);
      }
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile()) files.push(candidate);
    }
  }
  return files;
}

function scanNativeRuntimeCompatibility(root) {
  const elfFiles = [];
  const machoFiles = [];
  const elfVersions = [];
  const macosVersions = [];
  for (const file of walkFiles(root)) {
    const prefix = firstBytes(file);
    if (prefix.length === 4 && prefix.equals(ELF_MAGIC)) {
      const versions = glibcVersionsFromBuffer(fs.readFileSync(file));
      elfFiles.push({file, versions});
      elfVersions.push(...versions);
      continue;
    }
    if (prefix.length < 4) continue;
    const magicBE = prefix.readUInt32BE(0);
    const magicLE = prefix.readUInt32LE(0);
    if (
      [MACHO_32, MACHO_64, FAT_32, FAT_64].includes(magicBE) ||
      [MACHO_32, MACHO_64, FAT_32, FAT_64].includes(magicLE)
    ) {
      let versions;
      try {
        versions = machoMinimumVersionsFromBuffer(fs.readFileSync(file));
      } catch (error) {
        throw new Error(`Mach-O compatibility audit failed for ${file}: ${error.message || error}`);
      }
      if (versions.length === 0) {
        throw new Error(`Mach-O file has no macOS minimum-version load command: ${file}`);
      }
      machoFiles.push({file, versions});
      macosVersions.push(...versions);
    }
  }
  return {
    elfFiles,
    elfMinimumGlibc: highestVersion(elfVersions),
    machoFiles,
    macosMinimumSystemVersion: highestVersion(macosVersions),
  };
}

function infoPlistMinimumSystemVersion(infoPlist) {
  const text = fs.readFileSync(infoPlist, 'utf8');
  const match = /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  if (!match) throw new Error(`Info.plist has no LSMinimumSystemVersion: ${infoPlist}`);
  numericVersion(match[1]);
  return match[1];
}

function verifyNativeRuntimeCompatibility(root, targetId, manifest) {
  if (targetId !== 'linux-x64' && targetId !== 'macos-arm64') {
    return {
      elfFiles: [],
      elfMinimumGlibc: null,
      machoFiles: [],
      macosMinimumSystemVersion: null,
    };
  }
  const scan = scanNativeRuntimeCompatibility(root);
  if (targetId === 'linux-x64') {
    const declared = manifest.target?.libc?.minimumVersion;
    numericVersion(declared);
    if (!scan.elfMinimumGlibc || scan.elfFiles.length === 0) {
      throw new Error('Linux portable payload contains no auditable ELF runtime');
    }
    if (compareVersions(scan.elfMinimumGlibc, declared) > 0) {
      throw new Error(
        `Linux payload requires GLIBC_${scan.elfMinimumGlibc}, above manifest ${declared}`,
      );
    }
  } else if (targetId === 'macos-arm64') {
    const app = path.join(root, 'SmartPerfetto.app');
    const declared = manifest.target?.minimumSystemVersion;
    const infoMinimum = infoPlistMinimumSystemVersion(
      path.join(app, 'Contents', 'Info.plist'),
    );
    numericVersion(declared);
    if (declared !== infoMinimum) {
      throw new Error(
        `macOS manifest minimum ${declared} does not match Info.plist ${infoMinimum}`,
      );
    }
    if (!scan.macosMinimumSystemVersion || scan.machoFiles.length === 0) {
      throw new Error('macOS portable payload contains no auditable Mach-O runtime');
    }
    if (compareVersions(scan.macosMinimumSystemVersion, declared) > 0) {
      throw new Error(
        `macOS payload requires ${scan.macosMinimumSystemVersion}, above declared ${declared}`,
      );
    }
  }
  return scan;
}

function updateMacosInfoPlist(app, floor) {
  numericVersion(floor);
  const scan = scanNativeRuntimeCompatibility(app);
  if (!scan.macosMinimumSystemVersion) {
    throw new Error('macOS app contains no Mach-O minimum-version evidence');
  }
  const minimum = compareVersions(scan.macosMinimumSystemVersion, floor) > 0
    ? scan.macosMinimumSystemVersion
    : floor;
  execFileSync(
    '/usr/bin/plutil',
    [
      '-replace',
      'LSMinimumSystemVersion',
      '-string',
      minimum,
      path.join(app, 'Contents', 'Info.plist'),
    ],
    {stdio: 'pipe'},
  );
  return minimum;
}

function main(argv) {
  if (argv.length === 3 && argv[0] === '--update-macos-info') {
    console.log(updateMacosInfoPlist(path.resolve(argv[1]), argv[2]));
    return;
  }
  throw new Error(
    'Usage: native-runtime-compat.cjs --update-macos-info <SmartPerfetto.app> <minimum-floor>',
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  compareVersions,
  glibcVersionsFromBuffer,
  highestVersion,
  infoPlistMinimumSystemVersion,
  machoMinimumVersionsFromBuffer,
  scanNativeRuntimeCompatibility,
  updateMacosInfoPlist,
  verifyNativeRuntimeCompatibility,
};
