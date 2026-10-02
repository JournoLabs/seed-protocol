// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { deployToLocalHardhat, ValuesStore } from './utils/deploy'
import path                                  from 'path'
import fs                       from 'fs'



async function main() {

  await deployToLocalHardhat()

  // let valuesStore: ValuesStore = {}
  //
  // valuesStore = await deployToLocalHardhat()

  // const logFileName = `value_store_${new Date().getTime()}.json`;
  //
  // const filePath = path.join(__dirname, '../', logFileName);
  // const data = JSON.stringify(valuesStore.modelUids, null, 2);
  //
  // fs.writeFile(filePath, data, (err) => {
  //   if (err) {
  //     console.error('Error writing to log file:', err);
  //   } else {
  //     console.log(`Object written to ${logFileName}`);
  //   }
  // });

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
