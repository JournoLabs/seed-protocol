import {keccak256, toUtf8Bytes} from 'ethers'


async function main() {
  const signature = 'multiPublish((string,bytes32,bytes32,bytes32,bytes32,bool,(bytes32,(address,uint64,bool,bytes32,bytes,uint256)[])[],(string,bytes32)[])[])'
  const selector = keccak256(toUtf8Bytes(signature)).slice(0, 10)
  console.log(selector)
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
