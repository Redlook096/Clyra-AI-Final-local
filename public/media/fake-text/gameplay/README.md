# Fake Text Story gameplay library

These local editing assets are 40-second, silent, 720 x 1280 H.264 clips prepared from the user-supplied sources below:

- Subway Surfers: https://youtu.be/QPW3XwBoQlw
- Minecraft: https://youtu.be/u7kdVe8q5zs
- GTA: https://youtu.be/ZtLrNBdXT7M

The source videos identify themselves as no-copyright gameplay. Source audio is removed so it cannot conflict with message narration. Rebuild the library with:

```bash
./tools/prepare-fake-text-gameplay.sh
```

The creator stores only a library clip ID in imported project data and resolves it against `src/data/fakeTextGameplay.ts`. This prevents imported project files from injecting arbitrary media paths.
