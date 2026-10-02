import { readFileSync } from "node:fs";
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { Interface } from "ethers";
import { SEED_EXTENSION_FUNCTIONS } from "../../scripts/lib/extensions.js";

/**
 * A stand-in for the OP Sepolia stack, for `rehearse:local` (docs/deploy-plan.md, P6.1):
 * EAS, EntryPoint, a ManagedAccountFactory routing AccountExtension, the old Seed
 * registration (setEas included) and one account.
 *
 * Account 0 is the factory admin (EXTENSION_ROLE); account 1 owns the account.
 * Replaces setup_local.ts.
 */

function abi(artifactPath: string): Interface {
  const url = new URL(`../../artifacts/${artifactPath}`, import.meta.url);
  return new Interface(JSON.parse(readFileSync(url, "utf8")).abi);
}

/** Router `ExtensionFunction`s for every function in `iface` (or just `names`). */
function functions(iface: Interface, names?: string[]) {
  const fragments = names
    ? names.map((n) => iface.getFunction(n)!)
    : iface.fragments.flatMap((f) => (f.type === "function" ? [iface.getFunction(f.format("sighash"))!] : []));
  return fragments.map((f) => ({ functionSelector: f.selector, functionSignature: f.format("sighash") }));
}

const ACCOUNT_EXTENSION = "@thirdweb-dev/contracts/prebuilts/account/utils/AccountExtension.sol/AccountExtension.json";
const SEED_PROTOCOL_EXTENSION = "contracts/SeedProtocolExtension.sol/SeedProtocolExtension.json";
const LEGACY_SET_EAS = new Interface(["function setEas(address)"]);

export default buildModule("LocalStack", (m) => {
  const factoryAdmin = m.getAccount(0);
  const accountAdmin = m.getAccount(1);

  const schemaRegistry = m.contract("SchemaRegistry", []);
  const eas = m.contract("EAS", [schemaRegistry]);
  const entryPoint = m.contract("EntryPoint", []);
  const accountExtension = m.contract("AccountExtension", []);

  const factory = m.contract("ManagedAccountFactory", [
    factoryAdmin,
    entryPoint,
    [
      {
        metadata: { name: "AccountExtension", metadataURI: "", implementation: accountExtension },
        functions: functions(abi(ACCOUNT_EXTENSION)),
      },
    ],
  ]);

  // What OP Sepolia routes before the rollout: "SeedProtocolExtension" with setEas.
  // The current contract stands in for the old implementation; the Router doesn't
  // check that it actually has setEas.
  const oldSeedExtension = m.contract("SeedProtocolExtension", [eas], { id: "OldSeedProtocolExtension" });
  m.call(
    factory,
    "addExtension",
    [
      {
        metadata: { name: "SeedProtocolExtension", metadataURI: "", implementation: oldSeedExtension },
        functions: [...functions(abi(SEED_PROTOCOL_EXTENSION), SEED_EXTENSION_FUNCTIONS), ...functions(LEGACY_SET_EAS)],
      },
    ],
    { id: "AddOldSeedExtension" },
  );

  const createAccount = m.call(factory, "createAccount", [accountAdmin, "0x"]);
  const account = m.contractAt(
    "ManagedAccount",
    m.readEventArgument(createAccount, "AccountCreated", "account"),
    { id: "Account" },
  );
  m.send("FundAccount", account, 10n ** 18n);

  return { schemaRegistry, eas, entryPoint, accountExtension, factory, oldSeedExtension, account };
});
