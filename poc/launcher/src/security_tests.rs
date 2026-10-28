use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("artifacts/distribution-tests");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("launcher-security-{}-{}", std::process::id(), STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn complete_runtime(&self) -> PathBuf {
        let root = self.0.join("runtime");
        fs::create_dir(&root).unwrap();
        for name in REQUIRED_FILES {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"fixture, never executed").unwrap();
        }
        fs::write(root.join(COMPLETE_FILE), format!("KindleToZip {APP_VERSION}\nsha256={}\n", hex(&[1; 32]))).unwrap();
        root
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn powershell(script: &str, path: &Path) -> String {
    let executable = PathBuf::from(env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script = format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); {script}");
    let modules = PathBuf::from(env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/Modules");
    let result = Command::new(executable).args(["-NoProfile", "-Command", &script]).env("PSModulePath", modules).env("KTZ_ACL_PATH", path).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap()
}

#[test]
fn portable_private_acl_replaces_shared_inherited_and_explicit_grants_on_reuse() {
    let fixture = Fixture::new();
    powershell("& $env:SystemRoot\\System32\\icacls.exe $env:KTZ_ACL_PATH /grant '*S-1-1-0:(OI)(CI)M'; if ($LASTEXITCODE) { exit 1 }", &fixture.0);
    let acl = PrivateAcl::current().unwrap();
    for name in ["runtime", "temp"] {
        let root = fixture.0.join(name);
        fs::create_dir(&root).unwrap();
        let file = root.join("existing-state.txt");
        fs::write(&file, b"retain existing state").unwrap();
        powershell("& $env:SystemRoot\\System32\\icacls.exe $env:KTZ_ACL_PATH /grant '*S-1-1-0:M'; if ($LASTEXITCODE) { exit 1 }", &file);
        acl.protect_tree(&root).unwrap();
        // Also check a new descendant inherits only the current user's grant.
        let child = root.join("new-child");
        fs::create_dir(&child).unwrap();
        for path in [&root, &file, &child] {
            powershell("$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules = @((Get-Acl -LiteralPath $env:KTZ_ACL_PATH).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq Allow); if ($rules.Count -eq 0 -or @($rules | Where-Object { $_.IdentityReference.Value -ne $sid }).Count) { throw 'non-private ACL' }", path);
        }
        acl.protect_tree(&root).unwrap();
        assert_eq!(fs::read(file).unwrap(), b"retain existing state");
    }
}

#[test]
fn portable_private_acl_refuses_external_hardlinks_without_changing_their_acl() {
    let fixture = Fixture::new();
    let outside = fixture.0.join("outside.txt");
    fs::write(&outside, b"outside must remain unchanged").unwrap();
    let before = powershell("(Get-Acl -LiteralPath $env:KTZ_ACL_PATH).Sddl", &outside);
    let root = fixture.0.join("temp");
    fs::create_dir(&root).unwrap();
    fs::hard_link(&outside, root.join("linked.txt")).unwrap();
    let error = PrivateAcl::current().unwrap().protect_tree(&root).unwrap_err();
    assert!(error.contains("通常フォルダ"), "{error}");
    assert_eq!(powershell("(Get-Acl -LiteralPath $env:KTZ_ACL_PATH).Sddl", &outside), before);
    assert_eq!(fs::read(outside).unwrap(), b"outside must remain unchanged");
}

#[test]
fn portable_completed_runtime_rejects_intermediate_junctions_without_touching_target() {
    for directory in ["node", "app", "node_modules/playwright-core/lib"] {
        let fixture = Fixture::new();
        let root = fixture.complete_runtime();
        let inside = root.join(directory);
        // Include a dependency directory that is not one of REQUIRED_FILES.
        fs::create_dir_all(&inside).unwrap();
        let outside = fixture.0.join("outside");
        fs::rename(&inside, &outside).unwrap();
        fs::write(outside.join("untouched.txt"), b"outside must remain unchanged").unwrap();
        let outside_acl = powershell("(Get-Acl -LiteralPath $env:KTZ_ACL_PATH).Sddl", &outside);
        let shell_path = PathBuf::from(env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let status = Command::new(shell_path).args(["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:KTZ_LINK -Target $env:KTZ_TARGET | Out-Null"])
            .env("KTZ_LINK", &inside).env("KTZ_TARGET", &outside).status().unwrap();
        assert!(status.success());
        if directory == "node" { assert!(inside.join("node.exe").is_file(), "junction fixture must resolve its original file"); }
        let result = verify_complete_runtime(&root, &[1; 32]);
        assert!(PrivateAcl::current().unwrap().protect_tree(&root).is_err());
        // Remove the junction before the fixture's recursive cleanup.
        fs::remove_dir(&inside).unwrap();
        assert_eq!(fs::read(outside.join("untouched.txt")).unwrap(), b"outside must remain unchanged");
        assert_eq!(powershell("(Get-Acl -LiteralPath $env:KTZ_ACL_PATH).Sddl", &outside), outside_acl);
        let error = result.expect_err("a complete receipt must not authorize a junction inside the runtime");
        assert!(error.contains("通常フォルダ"), "{error}");
    }
}
