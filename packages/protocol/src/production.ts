import {
  BRIDGE_FIREBASE_APP_ID,
  CODRA_PROJECT_ID,
  DESKTOP_APPCHECK_FIREBASE_APP_ID,
  FUNCTION_REGION,
  ProductionDeploymentConfigSchema,
  createProductionDeployment,
  productionPublicConfig,
  type ProductionDeploymentConfig,
  type ApprovedDesktopAppCheckInput,
} from "./deployment";

export {
  BRIDGE_FIREBASE_APP_ID,
  CODRA_PROJECT_ID,
  DESKTOP_APPCHECK_FIREBASE_APP_ID,
  FUNCTION_REGION,
  ProductionDeploymentConfigSchema,
  productionPublicConfig,
  createProductionDeployment,
};
export type { ProductionDeploymentConfig, ApprovedDesktopAppCheckInput };

export function parseProductionDeployment(
  input: Parameters<typeof createProductionDeployment>[0],
): ProductionDeploymentConfig {
  return ProductionDeploymentConfigSchema.parse(
    createProductionDeployment(input),
  );
}
