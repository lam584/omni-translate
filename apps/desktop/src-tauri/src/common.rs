pub(crate) trait MapErrToString<T> {
    fn map_err_str(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> MapErrToString<T> for Result<T, E> {
    fn map_err_str(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}
