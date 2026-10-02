#!/usr/bin/env python3
"""Release the TypeScript compatibility fix without bundling unrelated work.

Patch the verified published tarballs in memory. Only the listed files may
change; write release artifacts to the existing workspace build output.
Run without arguments to prepare and validate, or with --publish to release.
"""

import argparse
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'dist'
RELEASES = [
    ('@geastack/geatsc-plugin-gea', '0.1.13', '0.1.14', {}),
    ('@geastack/geatsc-plugin-windows-native', '0.1.1', '0.1.2', {}),
    ('@geastack/core', '0.1.32', '0.1.33', {'@geastack/geatsc-plugin-gea': '^0.1.14'}),
    ('@geastack/windows', '0.1.0', '0.1.1', {
        '@geastack/core': '^0.1.33', '@geastack/geatsc-plugin-gea': '^0.1.14',
        '@geastack/geatsc-plugin-windows-native': '^0.1.2'}),
    ('@geastack/apple', '0.2.12', '0.2.13', {
        '@geastack/core': '^0.1.33', '@geastack/geatsc-plugin-gea': '^0.1.14'}),
    ('@geastack/simulator', '0.1.12', '0.1.13', {'@geastack/core': '^0.1.33'}),
    ('@geastack/native-webgl-angle', '0.1.7', '0.1.8', {'@geastack/apple': '^0.2.13'}),
    ('@geastack/cli', '0.1.90', '0.1.91', {'@geastack/simulator': '^0.1.13'}),
    ('create-geastack', '0.1.19', '0.1.20', {'@geastack/cli': '^0.1.91'}),
]


def metadata(name, version):
    url = f'https://registry.npmjs.org/{quote(name, safe="")}/{version}'
    with urlopen(url) as response:
        return json.load(response)


def archive(metadata):
    with urlopen(metadata['dist']['tarball']) as response:
        data = response.read()
    algorithm, digest = metadata['dist']['integrity'].split('-', 1)
    assert base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == digest
    members = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
        for member in source:
            if member.isdir():
                continue
            assert member.isfile(), f'Unexpected archive member: {member.name}'
            assert member.name.startswith('package/') and '..' not in Path(member.name).parts
            members.append((copy.copy(member), source.extractfile(member).read()))
    assert len({member.name for member, _ in members}) == len(members)
    return members


def replace_once(text, before, after):
    assert text.count(before) == 1, f'Published source does not match expected patch: {before}'
    return text.replace(before, after)


def prepare(name, before, after, dependencies):
    original = archive(metadata(name, before))
    files = {member.name: data for member, data in original}
    manifest = json.loads(files['package/package.json'])
    assert manifest['name'] == name and manifest['version'] == before
    manifest['version'] = after
    if dependencies:
        manifest.setdefault('dependencies', {}).update(dependencies)
    if name in ('@geastack/geatsc-plugin-gea', '@geastack/geatsc-plugin-windows-native'):
        manifest.setdefault('dependencies', {})['typescript'] = '^5.9.3'
        manifest['peerDependencies'].pop('typescript')
        manifest['devDependencies'].pop('typescript')
    if name in ('@geastack/simulator', '@geastack/native-webgl-angle'):
        manifest['devDependencies']['typescript'] = '^5.9.3'
    allowed = {'package/package.json'}
    if name == '@geastack/cli':
        manifest['starterDependencies'].update({'@geastack/core': '^0.1.33', '@geastack/apple': '^0.2.13'})
        file = 'package/src/create-geastack.mjs'
        text = files[file].decode()
        text = replace_once(text,
            "const starterFontPath = fileURLToPath",
            "// The native tooling uses the TypeScript 5 compiler API. Do not let a\n"
            "// floating version in an older example select an incompatible major.\n"
            "const typescriptDependencyDefault = '^5.9.3'\n"
            "const starterFontPath = fileURLToPath")
        text = replace_once(text,
            "      typescript: sourcePackage.devDependencies?.typescript || 'latest',",
            "      typescript: !sourcePackage.devDependencies?.typescript || ['latest', '*'].includes(sourcePackage.devDependencies.typescript)\n"
            "        ? typescriptDependencyDefault\n"
            "        : sourcePackage.devDependencies.typescript,")
        text = replace_once(text,
            "  writeJson(path.join(targetDir, 'package.json'), packageJson({",
            "  const projectPackage = packageJson({")
        text = replace_once(text,
            "    sourceManifest\n  }))",
            "    sourceManifest\n  })\n  writeJson(path.join(targetDir, 'package.json'), projectPackage)")
        line = "  ensureJson(path.join(targetDir, 'tsconfig.json'), () => tsconfigJson(targets))"
        text = replace_once(text, line, line + "\n" +
            "  if (/^(?:\\^|~)?5\\./.test(projectPackage.devDependencies.typescript)) {\n"
            "    const configPath = path.join(targetDir, 'tsconfig.json')\n"
            "    const config = readJson(configPath)\n"
            "    if (config.compilerOptions?.ignoreDeprecations === '6.0') {\n"
            "      config.compilerOptions.ignoreDeprecations = '5.0'\n"
            "      writeJson(configPath, config)\n"
            "    }\n"
            "  }")
        assert text == (ROOT / 'cli/src/create-geastack.mjs').read_text()
        subprocess.run(['node', '--input-type=module', '--check'], input=text, text=True, check=True)
        files[file] = text.encode()
        allowed.add(file)
        file = 'package/starters/bundled/counter/package.json'
        starter = json.loads(files[file])
        starter['devDependencies']['typescript'] = '^5.9.3'
        files[file] = (json.dumps(starter, indent=2) + '\n').encode()
        allowed.add(file)
    files['package/package.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    changed = {member.name for member, data in original if files[member.name] != data}
    assert changed == allowed, (name, changed, allowed)
    output = OUTPUT / f'{name.replace("@", "").replace("/", "-")}-{after}.tgz'
    with tarfile.open(output, 'w:gz', format=tarfile.PAX_FORMAT) as destination:
        for member, _ in original:
            data = files[member.name]
            member.size = len(data)
            destination.addfile(member, io.BytesIO(data))
    print(f'{name}@{after}: verified {len(files)} files; changed {", ".join(sorted(changed))}', flush=True)
    return output, files


def verify_published(name, version, expected):
    for attempt in range(120):
        try:
            actual = {member.name: data for member, data in archive(metadata(name, version))}
            assert actual == expected, f'Registry payload differs for {name}@{version}'
            with urlopen(f'https://registry.npmjs.org/{quote(name, safe="")}/latest') as response:
                latest = json.load(response)['version']
            if latest == version:
                print(f'Verified registry payload and latest tag: {name}@{version}', flush=True)
                return
        except HTTPError as error:
            if error.code != 404:
                raise
        if attempt == 0:
            print(f'Waiting for npm registry visibility: {name}@{version}', flush=True)
        time.sleep(5)
    raise RuntimeError(f'Registry has not exposed {name}@{version} with its latest tag')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    assert OUTPUT.is_dir(), 'Use the existing workspace build output; do not create another directory'
    prepared = [(name, after, *prepare(name, before, after, deps)) for name, before, after, deps in RELEASES]
    if not args.publish:
        return
    for name, version, path, files in prepared:
        try:
            metadata(name, version)
        except HTTPError as error:
            if error.code != 404:
                raise
            command = ['npm', 'publish', str(path)]
            if name.startswith('@geastack/'):
                command += ['--userconfig', str(Path.home() / '.npmrc-geastack')]
            command += ['--access', 'public', '--tag', 'latest', '--ignore-scripts', '--loglevel', 'error']
            result = subprocess.run(command,
                                    capture_output=True, text=True)
            if result.returncode:
                if 'Cannot publish over previously staged version' not in result.stderr:
                    print(result.stderr, flush=True)
                    result.check_returncode()
                print(f'Npm already accepted this staged version: {name}@{version}', flush=True)
            else:
                print(result.stdout.strip(), flush=True)
    # npm scans new releases asynchronously. Queue the dependencies in order,
    # then verify every payload once the registry exposes them.
    for name, version, path, files in prepared:
        verify_published(name, version, files)


if __name__ == '__main__':
    main()
