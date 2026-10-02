import {testPublishRequestData} from './utils/test_data'


async function main() {
  console.log(JSON.stringify(testPublishRequestData, null, 2))

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

//
