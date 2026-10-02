// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./IEAS_SeedProtocol.sol";
import {AttestationRequest, MultiAttestationRequest} from "./IEAS_SeedProtocol.sol";
import {PublishRequestData, PublishReturnData, PropertyToUpdateWithSeed} from "../interfaces/ISeedProtocol.sol";
import "@openzeppelin/contracts/utils/Strings.sol";


contract SeedProtocolTest is OwnableUpgradeable {
    IEAS_SeedProtocol public eas;

    event Log(string message);
    event PublishResult(string jsonResult);

    function initialize(
        address _eas
    ) public initializer {
        eas = IEAS_SeedProtocol(_eas);
    }

    function createSeed(bytes32 schemaUid, bool revocable) public payable returns (bytes32) {

        emit Log("Calling createSeed");
        emit Log(string(abi.encodePacked(bytes32ToHexString(schemaUid))));

        // Prepare the Seed attestation
        AttestationRequestData memory seedData = AttestationRequestData({
            recipient: address(0),
            expirationTime: 0,
            revocable: revocable,
            refUID: bytes32(0),
            data: abi.encode(schemaUid),
            value: uint256(0)
        });

        AttestationRequest memory seedRequest = AttestationRequest({
            schema: schemaUid,
            data: seedData
        });

        bytes32 seedUid = eas.attest(seedRequest);

        return seedUid;
    }

    function createVersion(bytes32 seedUid, bytes32 versionSchemaUid) public payable returns (bytes32) {

        emit Log("Calling createVersion with seedUid");
//        emit Log(string(abi.encodePacked(bytes32ToHexString(versionSchemaUid))));
//        emit Log(string(abi.encodePacked(bytes32ToHexString(seedUid))));

        // Prepare the Version attestation
        AttestationRequestData memory versionData = AttestationRequestData({
            recipient: address(0),
            expirationTime: 0,
            revocable: true,
            refUID: seedUid,
            data: abi.encode(versionSchemaUid),
            value: uint256(0)
        });

        emit Log("Has versionData");

        AttestationRequest memory versionRequest = AttestationRequest({
            schema: versionSchemaUid,
            data: versionData
        });

        emit Log("Calling attest with versionRequest");

//        bytes32 versionUid = eas.attest(versionRequest);

        emit Log("Has versionUid");

        return seedUid;
    }

    // Utility function to convert bytes32 to string
    function bytes32ToString(bytes32 _bytes32) public pure returns (string memory) {
        bytes memory bytesArray = new bytes(32);
        for (uint256 i; i < 32; i++) {
            bytesArray[i] = _bytes32[i];
            if (_bytes32[i] == 0) {
                break;
            }
        }
        return string(bytesArray);
    }

    // Converts bytes32 to a hexadecimal string
    function bytes32ToHexString(bytes32 _bytes32) public pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(64); // Length of a hexadecimal representation of bytes32
        for (uint i = 0; i < 32; i++) {
            str[2 * i] = alphabet[uint8(_bytes32[i] >> 4)];
            str[2 * i + 1] = alphabet[uint8(_bytes32[i] & 0x0f)];
        }
        return string(str);
    }

    function convertBytesToString(bytes memory data) public pure returns (string memory) {
        return string(data);
    }


    function publish(PublishRequestData memory request) public payable returns (bytes32, bytes32) {

        emit Log("Calling publish");

        bytes32 seedUid = request.seedUid;
        bytes32 versionUid = request.versionUid;

        if (seedUid == bytes32(0)) {
            seedUid = createSeed(request.seedSchemaUid, request.seedIsRevocable);
            emit Log("Created seedUid");
            emit Log(string(abi.encodePacked(bytes32ToHexString(seedUid))));
        }

        if (seedUid != bytes32(0) && versionUid == bytes32(0)) {
//            emit Log("Calling createVersion from publish with seedUid ->");
//            emit Log(string(abi.encodePacked(bytes32ToHexString(seedUid))));
            versionUid = createVersion(seedUid, request.versionSchemaUid);
            emit Log("Created versionUid");
            emit Log(string(abi.encodePacked(bytes32ToHexString(versionUid))));
        }

//        // Create updated listOfAttestations with versionUid as refUID
//        for (uint k = 0; k < request.listOfAttestations.length; k++) {
//            emit Log("Has attesations to update");
//            for (uint l = 0; l < request.listOfAttestations[k].data.length; l++) {
//                // Prepare data for each attestation, referencing the Version UID
//                request.listOfAttestations[k].data[l].refUID = versionUid;
//                emit Log("Attached versionUid to attestation");
//                emit Log(string(abi.encodePacked(bytes32ToHexString(versionUid))));
//            }
//        }

        return (seedUid, versionUid);
    }

    function multiPublish(PublishRequestData[] memory requests) public payable returns (bytes32[] memory) {
        bytes32[] memory result = new bytes32[](requests.length);
//        uint numberOfPropertiesToUpdate = 0;
//
//        for (uint i = 0; i < requests.length; i++) {
//            PublishRequestData memory requestToPublish = requests[i];
//            numberOfPropertiesToUpdate += requestToPublish.propertiesToUpdate.length;
//        }
//
//        QueuedUpdate[] memory queuedUpdates = new QueuedUpdate[](numberOfPropertiesToUpdate);

        for (uint i = 0; i < requests.length; i++) {
            PublishRequestData memory requestToPublish = requests[i];
            emit Log("Request publishing");
            emit Log(string(abi.encodePacked(requestToPublish.localId)));
            // Each publish call can return a list of properties that need to be updated
            (bytes32 newSeedUid, bytes32 newVersionUid) = publish(requestToPublish);

            // Update the current request attestations with the newVersionUid as the refUID
            for (uint j = 0; j < requestToPublish.listOfAttestations.length; j++) {
                MultiAttestationRequest memory attestationRequest = requestToPublish.listOfAttestations[j];
                for (uint k = 0; k < attestationRequest.data.length; k++) {
                    attestationRequest.data[k].refUID = newVersionUid;
                    emit Log("Attached newVersionUid to attestation");
                    emit Log(string(abi.encodePacked(bytes32ToHexString(newVersionUid))));
                }
            }

            // Update other requests that have properties that need to reference the newSeedUid
            PropertyToUpdateWithSeed[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            // For each property, we find the corresponding request and update the property's value as the seedUid
            for (uint l = 0; l < propertiesToUpdate.length; l++) {
                emit Log("Has properties to update");
                PropertyToUpdateWithSeed memory propertyToUpdate = propertiesToUpdate[l];
                for (uint m = 0; m < requests.length; m++) {
                    emit Log("Has requests to search");
                    PublishRequestData memory targetForUpdate = requests[m];
                    if ( Strings.equal(targetForUpdate.localId, propertyToUpdate.publishLocalId)) {
                        emit Log("Found request to update");
                        emit Log(string(abi.encodePacked(targetForUpdate.localId)));

                        for (uint n = 0; n < targetForUpdate.listOfAttestations.length; n++) {
                            emit Log("Has attestations to update");
                            MultiAttestationRequest memory attestationRequest = targetForUpdate.listOfAttestations[n];
                            emit Log("================");
                            emit Log(string(abi.encodePacked(bytes32ToHexString(attestationRequest.schema))));
                            emit Log(string(abi.encodePacked(bytes32ToHexString(propertyToUpdate.propertySchemaUid))));
                            emit Log("================");
                            if (attestationRequest.schema == propertyToUpdate.propertySchemaUid) {
                                attestationRequest.data[0].data = abi.encode(newSeedUid);
                                emit Log("Added newSeedUid to attestation data");
                                emit Log(string(abi.encodePacked(bytes32ToHexString(newSeedUid))));
                            }
                        }
                    }
                }
            }

            // Call multiAttest with updated listOfAttestations
            (bool success, bytes memory returnedData) = address(eas).call{ value: msg.value }(
                abi.encodeWithSelector(
                    eas.multiAttest.selector,
                    requestToPublish.listOfAttestations
                )
            );

            require(success, "multiAttest call failed");

//            string memory returnedDataString = "[";

//            bytes32[] memory newSeedAndVersion = abi.decode(returnedData, (bytes32[]));

//            string memory json = string(abi.encodePacked(
//                '{"seedUid": "', bytes32ToHexString(newSeedAndVersion[0]),
//                '", "versionUid": "', bytes32ToHexString(newSeedAndVersion[1]),
//                '"}'
//            ));

//            emit PublishResult(json);

        }

        return result;


    }
}
