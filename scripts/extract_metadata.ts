// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import fs from 'fs'
import path                     from 'path'

async function main() {

  const sourceDirectory = path.resolve('artifacts/build-info');
  const targetDirectory = path.resolve('metadata');

  // Ensure the target directory exists
  if (!fs.existsSync(targetDirectory)) {
    fs.mkdirSync(targetDirectory, { recursive: true });
  }

  // Read all files in the source directory
  const files = fs.readdirSync(sourceDirectory);

  for (const file of files) {
    // Construct file path
    const filePath = path.join(sourceDirectory, file);

    // Read and parse JSON file
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Check for 'output.contracts' key in JSON data
    if (data.output && data.output.contracts) {
        for (const contractPath in data.output.contracts) {
            for (const contractName in data.output.contracts[contractPath]) {
                const contract = data.output.contracts[contractPath][contractName];
                if (contract.metadata) {
                    // Construct directory path for the contract metadata
                    const dirPath = path.join(targetDirectory, contractPath, contractName);

                    // Ensure the directory exists
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }

                    // Define path for the metadata file
                    const metadataFilePath = path.join(dirPath, `${contractName}_meta.json`);

                    // Write metadata to file
                    fs.writeFileSync(metadataFilePath, contract.metadata);
                    console.log(`Metadata for ${contractName} written to ${metadataFilePath}`);
                }
            }
        }
    }
    }

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
