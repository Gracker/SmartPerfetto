# Android Internals Knowledge Pack assets

This directory contains SmartPerfetto's trusted TUF root, a version lock, and
the compressed public Knowledge Pack snapshot used for offline installs.

The content is built from the complete Android Internals Wiki body corpus;
workflow status and review queues do not gate body inclusion. Navigation files
and generated reports are excluded, private-context lines are redacted, and
detected secrets fail publication.
It is licensed under `CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial`; possession
of the Pack does not itself grant a commercial license. See the license files
inside each bundled version.

Do not edit generated Pack files manually. Update the lock and assets with:

```bash
npm run knowledge-pack:fetch
```
