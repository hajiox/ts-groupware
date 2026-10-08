#requires -Version 5.1
param([ValidateSet('CEO_S','CEO-DOUGA')][string]$PcName='CEO_S')
$ErrorActionPreference='Stop'
# Issuer-side human input only. No clipboard read, no logging, no shared storage.
if ($env:COMPUTERNAME -cne 'TSA') {throw 'Run this issuer helper only on TSA.'}
Add-Type -AssemblyName System.Windows.Forms
$directory=Join-Path $env:LOCALAPPDATA 'TSG Codex MTG/provisioning-20261008'
$file=Join-Path $directory ($PcName+'.tsa.token')
if (-not (Test-Path -LiteralPath $directory)) {throw 'Protected provisioning directory is missing.'}
$acl=[IO.Directory]::GetAccessControl($directory)
$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
if (-not $acl.AreAccessRulesProtected) {throw 'Private ACL is required.'}
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {if($rule.IdentityReference.Value -notin $allowed){throw 'Unexpected ACL'}}
$form=New-Object Windows.Forms.Form
$form.Text='TSA専用キー保存 - '+$PcName
$form.Width=570;$form.Height=185;$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label
$label.Text='TSAの「接続キーをコピー」でコピーしたキーを貼り付けて保存してください。'
$label.Left=15;$label.Top=15;$label.Width=530;$label.Height=35
$inputBox=New-Object Windows.Forms.TextBox
$inputBox.Left=15;$inputBox.Top=55;$inputBox.Width=525;$inputBox.UseSystemPasswordChar=$true
$save=New-Object Windows.Forms.Button
$save.Text='保護保存';$save.Left=420;$save.Top=92;$save.Width=120
$save.Add_Click({
    $value=$inputBox.Text
    if($value -cnotmatch '\Atsa_data_[A-Za-z0-9_-]{43}\z') {[Windows.Forms.MessageBox]::Show('TSA専用キーの形式を確認してください。')|Out-Null;return}
    if(Test-Path -LiteralPath $file){[Windows.Forms.MessageBox]::Show('保存済みファイルがあります。上書きしません。')|Out-Null;return}
    try {
        $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($value+"`n")
        $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush()}finally{$stream.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}
        $inputBox.Clear();$value=$null;$form.Close()
    } catch {[Windows.Forms.MessageBox]::Show('保存できませんでした。秘密値は出力していません。')|Out-Null}
})
$form.Controls.AddRange(@($label,$inputBox,$save));$form.AcceptButton=$save
[void]$form.ShowDialog();$form.Dispose()
