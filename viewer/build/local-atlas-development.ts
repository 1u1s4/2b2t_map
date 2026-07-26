import { existsSync } from "node:fs";

export interface LocalAtlasDevelopmentPathOptions {
  readonly command: "build" | "serve";
  readonly configuredTileRoot?: string;
  readonly configuredRegionalTileRoot?: string;
  readonly configuredBackingRoot?: string;
  readonly repositoryTileRoot: string;
  readonly repositoryRegionalTileRoot: string;
}

export interface LocalAtlasDevelopmentPaths {
  readonly tileRoot?: string;
  readonly regionalTileRoot?: string;
  readonly backingRoot?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * `npm run dev` should find the repository library without requiring shell
 * variables. Explicit paths always win, while production builds stay
 * independent from any large, ignored local archive.
 */
export function resolveLocalAtlasDevelopmentPaths(
  options: LocalAtlasDevelopmentPathOptions,
): LocalAtlasDevelopmentPaths {
  const configuredTileRoot = nonEmpty(options.configuredTileRoot);
  const configuredRegionalTileRoot = nonEmpty(
    options.configuredRegionalTileRoot,
  );
  const configuredBackingRoot = nonEmpty(options.configuredBackingRoot);
  const repositoryLibraryAvailable =
    options.command === "serve" && existsSync(options.repositoryTileRoot);
  const tileRoot =
    configuredTileRoot ||
    (repositoryLibraryAvailable ? options.repositoryTileRoot : undefined);
  const regionalTileRoot =
    options.command === "serve" && tileRoot
      ? configuredRegionalTileRoot ||
        (configuredTileRoot
          ? `${configuredTileRoot}_regions`
          : options.repositoryRegionalTileRoot)
      : undefined;
  const backingRoot =
    configuredBackingRoot ||
    (!configuredTileRoot && repositoryLibraryAvailable
      ? options.repositoryTileRoot
      : undefined);

  return { tileRoot, regionalTileRoot, backingRoot };
}
