import Foundation
import Security

let arguments = CommandLine.arguments
guard arguments.count == 3, ["read", "write", "delete"].contains(arguments[1]),
      arguments[2].range(of: "^[a-z]+-[a-f0-9]{24}$", options: .regularExpression) != nil else {
    fputs("Invalid Keychain operation.\n", stderr)
    exit(2)
}
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.codexcontrol.agent",
    kSecAttrAccount as String: arguments[2]
]
var status: OSStatus
switch arguments[1] {
case "read":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data {
        FileHandle.standardOutput.write(data)
    }
case "write":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count <= 65536 else { exit(2) }
    status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
    }
default:
    status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { status = errSecSuccess }
}
if status == errSecItemNotFound { exit(44) }
if status != errSecSuccess {
    fputs("Keychain operation failed (\(status)).\n", stderr)
    exit(1)
}
