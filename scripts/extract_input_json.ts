import fs from 'fs'
import path                     from 'path'

async function main() {

  const sourceDirectory = path.resolve('artifacts/build-info');
  const targetDirectory = path.resolve('verify');

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

    // Check for 'input' key in JSON data
    if (data.input) {

      const fileName = file.split('.')[0];


      // Define path for the input json file
      const inputJsonFilePath = path.join(targetDirectory, `${fileName}_input.json`);

      // Write input json to file
      fs.writeFileSync(inputJsonFilePath, JSON.stringify(data.input));
      console.log(`Input JSON for verificatino written to ${inputJsonFilePath}`);
    }
    }

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
