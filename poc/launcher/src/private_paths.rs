//! Exact current-process-user ACLs for EXE-adjacent code and browser scratch.
//! Do not use inherited USERNAME/USERDOMAIN values to choose the principal.

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::fs::OpenOptions;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::{null_mut, read_unaligned};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetFileInformationByHandle(file: *mut c_void, information: *mut u32) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, information: *mut c_void, size: u32, needed: *mut u32) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
        fn SetKernelObjectSecurity(object: *mut c_void, information: u32, descriptor: *mut c_void) -> i32;
    }

    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) { unsafe { LocalFree(self.0); } }
    }

    pub struct PrivateAcl { descriptor: LocalMemory }

    fn acl_error() -> String {
        "Portable版の専用領域を現在のWindows利用者だけに保護できません。利用者プロファイルへ保存先を切り替えず停止しました。EXEと付随フォルダごと、アクセス権を設定できる書き込み可能な通常フォルダ（NTFSなど）へ移してください。".to_owned()
    }

    impl PrivateAcl {
        pub fn current() -> Result<Self, String> {
            let mut token = null_mut();
            if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 { return Err(acl_error()); }
            let result = (|| {
                let mut needed = 0;
                unsafe { GetTokenInformation(token, 1, null_mut(), 0, &mut needed); }
                if needed == 0 { return Err(acl_error()); }
                let mut user = vec![0_u8; needed as usize];
                if unsafe { GetTokenInformation(token, 1, user.as_mut_ptr().cast(), needed, &mut needed) } == 0 { return Err(acl_error()); }
                // TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first field
                // is a pointer. The byte buffer need not be pointer-aligned.
                let sid = unsafe { read_unaligned(user.as_ptr().cast::<*mut c_void>()) };
                let mut text = null_mut();
                if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 { return Err(acl_error()); }
                let memory = LocalMemory(text.cast());
                let mut length = 0;
                while unsafe { *text.add(length) } != 0 { length += 1; }
                let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| acl_error())?;
                drop(memory);
                // A protected, non-null DACL: only this token's user, inherited
                // by new files/directories. Ownership is not changed.
                let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})").encode_utf16().chain(Some(0)).collect();
                let mut descriptor = null_mut();
                if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()) } == 0 { return Err(acl_error()); }
                Ok(Self { descriptor: LocalMemory(descriptor) })
            })();
            unsafe { CloseHandle(token); }
            result
        }

        pub fn protect(&self, path: &Path) -> Result<(), String> {
            // Open the object itself, not a final reparse target. The descriptor
            // is set through this handle, with no recursive ACL-tool traversal.
            let file = OpenOptions::new().access_mode(0x0002_0000 | 0x0004_0000 | 0x0080)
                .share_mode(7).custom_flags(0x0020_0000 | 0x0200_0000).open(path).map_err(|_| acl_error())?;
            let metadata = file.metadata().map_err(|_| acl_error())?;
            if metadata.file_attributes() & 0x0000_0400 != 0 || !(metadata.is_file() || metadata.is_dir()) { return Err(acl_error()); }
            let mut information = [0_u32; 13];
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 { return Err(acl_error()); }
            // Changing a hard-linked file's ACL could change an object outside
            // this app-owned tree. Refuse rather than modify that other name.
            if metadata.is_file() && information[10] != 1 { return Err(acl_error()); }
            // SetKernelObjectSecurity does not propagate into existing child
            // objects: protect_tree validates and handles each one explicitly.
            if unsafe { SetKernelObjectSecurity(file.as_raw_handle(), 0x0000_0004 | 0x8000_0000, self.descriptor.0) } == 0 { return Err(acl_error()); }
            Ok(())
        }

        pub fn protect_tree(&self, root: &Path) -> Result<(), String> {
            let paths = crate::validated_tree_paths(root)?;
            for path in paths { self.protect(&path)?; }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub use windows::PrivateAcl;

#[cfg(not(windows))]
pub struct PrivateAcl;
#[cfg(not(windows))]
impl PrivateAcl {
    pub fn current() -> Result<Self, String> { Err("この配布物はWindows専用です。".to_owned()) }
    pub fn protect(&self, _: &std::path::Path) -> Result<(), String> { Self::current().map(|_| ()) }
    pub fn protect_tree(&self, path: &std::path::Path) -> Result<(), String> { self.protect(path) }
}
