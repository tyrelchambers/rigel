import XCTest
@testable import Helmsman

final class StorageTypesTests: XCTestCase {

    // MARK: - Decoding + display helpers

    func test_pvc_decode_capacityFallsBackToRequest() throws {
        // Pending PVC: no status.capacity yet → fall back to spec request.
        let json = """
        {"metadata":{"name":"data","namespace":"default","uid":"u1"},
         "spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":"10Gi"}},"storageClassName":"standard"},
         "status":{"phase":"Pending"}}
        """
        let pvc = try JSONDecoder.kube.decode(PersistentVolumeClaim.self, from: Data(json.utf8))
        XCTAssertEqual(pvc.capacity, "10Gi")
        XCTAssertEqual(pvc.phase, "Pending")
        XCTAssertEqual(pvc.accessModeLabels, ["RWO"])
    }

    func test_pvc_boundUsesStatusCapacity() throws {
        let json = """
        {"metadata":{"name":"data","namespace":"default","uid":"u2"},
         "spec":{"resources":{"requests":{"storage":"10Gi"}}},
         "status":{"phase":"Bound","capacity":{"storage":"10Gi"},"accessModes":["ReadWriteMany"]}}
        """
        let pvc = try JSONDecoder.kube.decode(PersistentVolumeClaim.self, from: Data(json.utf8))
        XCTAssertEqual(pvc.phase, "Bound")
        XCTAssertEqual(pvc.accessModeLabels, ["RWX"])
    }

    func test_pv_decode_claimAndReclaim() throws {
        let json = """
        {"metadata":{"name":"pv-1","uid":"u3"},
         "spec":{"capacity":{"storage":"20Gi"},"persistentVolumeReclaimPolicy":"Retain",
                 "claimRef":{"namespace":"prod","name":"data"},"storageClassName":"fast"},
         "status":{"phase":"Bound"}}
        """
        let pv = try JSONDecoder.kube.decode(PersistentVolume.self, from: Data(json.utf8))
        XCTAssertEqual(pv.capacity, "20Gi")
        XCTAssertEqual(pv.reclaimPolicy, "Retain")
        XCTAssertEqual(pv.claim, "prod/data")
        XCTAssertEqual(pv.phase, "Bound")
    }

    func test_storageClass_isDefaultFromAnnotation() throws {
        let json = """
        {"metadata":{"name":"standard","uid":"u4",
            "annotations":{"storageclass.kubernetes.io/is-default-class":"true"}},
         "provisioner":"rancher.io/local-path","reclaimPolicy":"Delete","volumeBindingMode":"WaitForFirstConsumer"}
        """
        let sc = try JSONDecoder.kube.decode(StorageClass.self, from: Data(json.utf8))
        XCTAssertTrue(sc.isDefault)
        XCTAssertEqual(sc.provisioner, "rancher.io/local-path")
        XCTAssertEqual(sc.volumeBindingMode, "WaitForFirstConsumer")
    }

    func test_storageClass_notDefaultByDefault() throws {
        let json = """
        {"metadata":{"name":"slow","uid":"u5"},"provisioner":"ebs.csi.aws.com"}
        """
        let sc = try JSONDecoder.kube.decode(StorageClass.self, from: Data(json.utf8))
        XCTAssertFalse(sc.isDefault)
    }

    func test_abbreviateAccessModes() {
        XCTAssertEqual(
            StorageDisplay.abbreviateAccessModes(["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"]),
            ["RWO", "ROX", "RWX", "RWOP"]
        )
        XCTAssertEqual(StorageDisplay.abbreviateAccessModes(["Weird"]), ["Weird"])
    }

    // MARK: - WorkloadAction

    func test_deletePVC_namespacedInvocationAndRisk() {
        let action = WorkloadAction.deletePVC(name: "data", namespace: "prod")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "pvc", "data", "-n", "prod"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }

    func test_deletePV_clusterScopedInvocation() {
        let action = WorkloadAction.deletePV(name: "pv-1")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "pv", "pv-1"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }
}
